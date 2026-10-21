// React Native binding: a C++ TurboModule over the hbc-pack C decoder (native/hbcpack.c).
// Registered on iOS by ios/KodespireHbcPackModuleProvider.mm and on Android by autolinking
// (react-native.config.js). src/react-native.js is the JavaScript side.

#pragma once

#include <ReactCommon/TurboModule.h>
#include <jsi/jsi.h>

#include <memory>

namespace facebook::react {

namespace kodespire_hbcpack {
class Promises;
}

class KodespireHbcPackModule : public TurboModule {
 public:
  static constexpr const char* kModuleName = "KodespireHbcPack";

  explicit KodespireHbcPackModule(std::shared_ptr<CallInvoker> jsInvoker);
  ~KodespireHbcPackModule() override;

  const std::shared_ptr<kodespire_hbcpack::Promises>& promises() const { return promises_; }
  std::weak_ptr<CallInvoker> invoker() const { return jsInvoker_; }

 private:
  // Pending promises, keyed by id. Only touched on the JS thread; workers hold a weak_ptr.
  std::shared_ptr<kodespire_hbcpack::Promises> promises_;
};

}  // namespace facebook::react
