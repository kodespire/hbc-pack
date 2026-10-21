// JSI binding over native/hbcpack.c. Same structure as @kodespire/zstd-js's module:
// synchronous methods run on the JS thread; async methods copy their inputs on the JS
// thread, run on a small worker pool, and settle their promise back on the JS thread
// through the CallInvoker. Workers never touch JSI values: they carry a promise id and
// plain bytes, so a job that finishes after a reload or teardown finds nothing to settle.
//
// Methods (see codegen/NativeKodespireHbcPack.ts):
//   version(): string
//   unpackSync(packed: Uint8Array, dictNames: string[] | null, dictData: Uint8Array[] | null): ArrayBuffer
//   unpack(packed, dictNames, dictData): Promise<ArrayBuffer>
//   unpackedSize(packed: Uint8Array): number
// Errors are Error objects with a numeric `hbcpackCode` (hbcpack_status).

#include "KodespireHbcPackModule.h"

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <pthread.h>

#include "hbcpack.h"

namespace facebook::react {
namespace kodespire_hbcpack {

// ---- worker pool -----------------------------------------------------------

class WorkerPool {
 public:
  static WorkerPool& shared() {
    static WorkerPool* pool = new WorkerPool();
    return *pool;
  }
  void submit(std::function<void()> job) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      queue_.push_back(std::move(job));
    }
    ready_.notify_one();
  }

 private:
  WorkerPool() {
    unsigned cores = std::thread::hardware_concurrency();
    unsigned count = std::clamp(cores > 1 ? cores - 1 : 1u, 1u, 2u);
    for (unsigned i = 0; i < count; i++) std::thread([this] { Run(); }).detach();
  }
  void Run() {
#if defined(__APPLE__)
    pthread_setname_np("hbc-pack");
#else
    pthread_setname_np(pthread_self(), "hbc-pack");
#endif
    for (;;) {
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [this] { return !queue_.empty(); });
        job = std::move(queue_.front());
        queue_.pop_front();
      }
      job();
    }
  }
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::function<void()>> queue_;
};

// ---- bytes and errors --------------------------------------------------------

// Hands the decoder's malloc'd output to JavaScript as an ArrayBuffer without copying.
class OwnedBuffer : public jsi::MutableBuffer {
 public:
  OwnedBuffer(uint8_t* data, size_t size) : data_(data), size_(size) {}
  ~OwnedBuffer() override { hbcpack_free(data_); }
  size_t size() const override { return size_; }
  uint8_t* data() override { return data_ ? data_ : &empty_; }

 private:
  uint8_t* data_;
  size_t size_;
  uint8_t empty_ = 0;
};

jsi::Value MakeError(jsi::Runtime& rt, hbcpack_status code) {
  jsi::Object error = rt.global()
                          .getPropertyAsFunction(rt, "Error")
                          .callAsConstructor(rt, jsi::String::createFromUtf8(rt, std::string("hbc-pack: ") + hbcpack_strerror(code)))
                          .asObject(rt);
  error.setProperty(rt, "hbcpackCode", static_cast<int>(code));
  return jsi::Value(std::move(error));
}

[[noreturn]] void ThrowTypeError(jsi::Runtime& rt, const std::string& message) {
  jsi::Value error = rt.global().getPropertyAsFunction(rt, "TypeError").callAsConstructor(rt, jsi::String::createFromUtf8(rt, message));
  throw jsi::JSError(rt, std::move(error));
}

struct Bytes {
  const uint8_t* data = nullptr;
  size_t size = 0;
};

// A Uint8Array value, read through buffer/byteOffset/byteLength (works on every RN version).
Bytes BytesOf(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  const std::string message = std::string(name) + " must be a Uint8Array";
  if (!value.isObject()) ThrowTypeError(rt, message);
  jsi::Object view = value.getObject(rt);
  if (!view.instanceOf(rt, rt.global().getPropertyAsFunction(rt, "Uint8Array"))) ThrowTypeError(rt, message);
  jsi::Value buffer = view.getProperty(rt, "buffer");
  jsi::Value offset = view.getProperty(rt, "byteOffset");
  jsi::Value length = view.getProperty(rt, "byteLength");
  if (!buffer.isObject() || !buffer.getObject(rt).isArrayBuffer(rt) || !offset.isNumber() || !length.isNumber()) ThrowTypeError(rt, message);
  jsi::ArrayBuffer array = buffer.getObject(rt).getArrayBuffer(rt);
  double start = offset.getNumber(), size = length.getNumber();
  if (start < 0 || size < 0 || start + size > static_cast<double>(array.size(rt))) ThrowTypeError(rt, message);
  return {array.data(rt) + static_cast<size_t>(start), static_cast<size_t>(size)};
}

Bytes BytesArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  if (index >= count) ThrowTypeError(rt, std::string(name) + " must be a Uint8Array");
  return BytesOf(rt, args[index], name);
}

// Dictionaries: (names: string[] | null, data: Uint8Array[] | null), copied.
struct Dicts {
  std::vector<std::string> names;
  std::vector<std::vector<uint8_t>> data;
  std::vector<hbcpack_dict> table;  // points into names/data; built by finish()
  void finish() {
    table.clear();
    for (size_t i = 0; i < names.size(); i++) table.push_back({names[i].c_str(), data[i].empty() ? nullptr : data[i].data(), data[i].size()});
  }
};

std::shared_ptr<Dicts> DictsArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index) {
  auto dicts = std::make_shared<Dicts>();
  if (index + 1 >= count || args[index].isNull() || args[index].isUndefined()) return dicts;
  if (!args[index].isObject() || !args[index].getObject(rt).isArray(rt) || !args[index + 1].isObject() || !args[index + 1].getObject(rt).isArray(rt)) {
    ThrowTypeError(rt, "dictNames and dictData must be arrays");
  }
  jsi::Array names = args[index].getObject(rt).getArray(rt);
  jsi::Array data = args[index + 1].getObject(rt).getArray(rt);
  size_t n = names.size(rt);
  if (data.size(rt) != n) ThrowTypeError(rt, "dictNames and dictData must have the same length");
  for (size_t i = 0; i < n; i++) {
    jsi::Value name = names.getValueAtIndex(rt, i);
    if (!name.isString()) ThrowTypeError(rt, "dictNames must contain strings");
    dicts->names.push_back(name.getString(rt).utf8(rt));
    Bytes bytes = BytesOf(rt, data.getValueAtIndex(rt, i), "dictData[i]");
    dicts->data.emplace_back(bytes.data, bytes.data + bytes.size);
  }
  dicts->finish();
  return dicts;
}

jsi::Function MakeFunction(jsi::Runtime& rt, const char* name, unsigned int length, jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), length, std::move(fn));
}

// ---- async -------------------------------------------------------------------

struct Result {
  hbcpack_status status = HBCPACK_OK;
  uint8_t* out = nullptr;
  size_t out_len = 0;
  ~Result() { hbcpack_free(out); }
};

class Promises {
 public:
  jsi::Value Create(jsi::Runtime& rt, uint64_t* id) {
    uint64_t key = next_++;
    jsi::Function executor = MakeFunction(rt, "executor", 2, [this, key](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t) {
      pending_.emplace(key, Pending{args[0].getObject(rt).getFunction(rt), args[1].getObject(rt).getFunction(rt)});
      return jsi::Value::undefined();
    });
    jsi::Value promise = rt.global().getPropertyAsFunction(rt, "Promise").callAsConstructor(rt, executor);
    *id = key;
    return promise;
  }
  void Settle(jsi::Runtime& rt, uint64_t id, Result& result) {
    auto it = pending_.find(id);
    if (it == pending_.end()) return;
    Pending pending = std::move(it->second);
    pending_.erase(it);
    if (result.status == HBCPACK_OK) {
      uint8_t* out = result.out; size_t len = result.out_len; result.out = nullptr;
      pending.resolve.call(rt, jsi::ArrayBuffer(rt, std::make_shared<OwnedBuffer>(out, len)));
    } else {
      pending.reject.call(rt, MakeError(rt, result.status));
    }
  }

 private:
  struct Pending { jsi::Function resolve; jsi::Function reject; };
  std::unordered_map<uint64_t, Pending> pending_;
  uint64_t next_ = 1;
};

// ---- module methods ------------------------------------------------------------

KodespireHbcPackModule& Self(TurboModule& module) { return static_cast<KodespireHbcPackModule&>(module); }

jsi::Value Version(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  return jsi::String::createFromUtf8(rt, HBCPACK_VERSION);
}

// unpackSync(packed, dictNames | null, dictData | null): ArrayBuffer
jsi::Value UnpackSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  Bytes src = BytesArg(rt, args, count, 0, "packed");
  std::shared_ptr<Dicts> dicts = DictsArg(rt, args, count, 1);
  hbcpack_options opts = {dicts->table.empty() ? nullptr : dicts->table.data(), dicts->table.size(), 0};
  uint8_t* out = nullptr; size_t out_len = 0;
  hbcpack_status st = hbcpack_unpack(src.data, src.size, &opts, &out, &out_len);
  if (st != HBCPACK_OK) throw jsi::JSError(rt, MakeError(rt, st));
  return jsi::ArrayBuffer(rt, std::make_shared<OwnedBuffer>(out, out_len));
}

// unpack(packed, dictNames | null, dictData | null): Promise<ArrayBuffer>. Inputs are copied.
jsi::Value Unpack(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  Bytes bytes = BytesArg(rt, args, count, 0, "packed");
  auto src = std::make_shared<std::vector<uint8_t>>(bytes.data, bytes.data + bytes.size);
  std::shared_ptr<Dicts> dicts = DictsArg(rt, args, count, 1);
  const std::shared_ptr<Promises>& promises = Self(module).promises();
  std::weak_ptr<CallInvoker> invoker = Self(module).invoker();
  uint64_t id = 0;
  jsi::Value promise = promises->Create(rt, &id);
  std::weak_ptr<Promises> weakPromises = promises;
  WorkerPool::shared().submit([src, dicts, weakPromises, invoker, id]() {
    auto result = std::make_shared<Result>();
    hbcpack_options opts = {dicts->table.empty() ? nullptr : dicts->table.data(), dicts->table.size(), 0};
    result->status = hbcpack_unpack(src->empty() ? nullptr : src->data(), src->size(), &opts, &result->out, &result->out_len);
    std::shared_ptr<CallInvoker> jsInvoker = invoker.lock();
    if (!jsInvoker) return;
    jsInvoker->invokeAsync([weakPromises, id, result](jsi::Runtime& rt) {
      if (std::shared_ptr<Promises> live = weakPromises.lock()) live->Settle(rt, id, *result);
    });
  });
  return promise;
}

// unpackedSize(packed): number
jsi::Value UnpackedSize(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  Bytes src = BytesArg(rt, args, count, 0, "packed");
  size_t size = 0;
  hbcpack_status st = hbcpack_unpacked_size(src.data, src.size, nullptr, &size);
  if (st != HBCPACK_OK) throw jsi::JSError(rt, MakeError(rt, st));
  return static_cast<double>(size);
}

}  // namespace kodespire_hbcpack

KodespireHbcPackModule::KodespireHbcPackModule(std::shared_ptr<CallInvoker> jsInvoker)
    : TurboModule(kModuleName, std::move(jsInvoker)), promises_(std::make_shared<kodespire_hbcpack::Promises>()) {
  using namespace kodespire_hbcpack;
  methodMap_["version"] = MethodMetadata{0, Version};
  methodMap_["unpackSync"] = MethodMetadata{3, UnpackSync};
  methodMap_["unpack"] = MethodMetadata{3, Unpack};
  methodMap_["unpackedSize"] = MethodMetadata{1, UnpackedSize};
}

KodespireHbcPackModule::~KodespireHbcPackModule() = default;

}  // namespace facebook::react
