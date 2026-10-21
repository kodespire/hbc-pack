/* JNI glue for com.kodespire.hbcpack.HbcPack (see HbcPack.java). */
#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "../hbcpack.h"

static void throw_iae(JNIEnv *env, const char *msg) {
  jclass cls = (*env)->FindClass(env, "java/lang/IllegalArgumentException");
  if (cls) (*env)->ThrowNew(env, cls, msg);
}

JNIEXPORT jbyteArray JNICALL Java_com_kodespire_hbcpack_HbcPack_unpack(JNIEnv *env, jclass cls, jbyteArray packed, jobjectArray dictNames, jobjectArray dictData) {
  (void)cls;
  if (!packed) { throw_iae(env, "packed is null"); return NULL; }
  jsize in_len = (*env)->GetArrayLength(env, packed);
  jbyte *in = (*env)->GetByteArrayElements(env, packed, NULL);
  if (!in) return NULL;

  hbcpack_dict *dicts = NULL; size_t ndicts = 0;
  jbyte **dict_elems = NULL; char **dict_names = NULL;
  if (dictNames && dictData) {
    ndicts = (size_t)(*env)->GetArrayLength(env, dictNames);
    if ((size_t)(*env)->GetArrayLength(env, dictData) != ndicts) { (*env)->ReleaseByteArrayElements(env, packed, in, JNI_ABORT); throw_iae(env, "dictNames and dictData differ in length"); return NULL; }
    dicts = calloc(ndicts, sizeof *dicts); dict_elems = calloc(ndicts, sizeof *dict_elems); dict_names = calloc(ndicts, sizeof *dict_names);
    for (size_t i = 0; i < ndicts && dicts; i++) {
      jstring js = (jstring)(*env)->GetObjectArrayElement(env, dictNames, (jsize)i);
      jbyteArray jb = (jbyteArray)(*env)->GetObjectArrayElement(env, dictData, (jsize)i);
      const char *name = js ? (*env)->GetStringUTFChars(env, js, NULL) : "";
      dict_names[i] = strdup(name);
      if (js) (*env)->ReleaseStringUTFChars(env, js, name);
      dict_elems[i] = jb ? (*env)->GetByteArrayElements(env, jb, NULL) : NULL;
      dicts[i].name = dict_names[i]; dicts[i].data = (const uint8_t *)dict_elems[i]; dicts[i].size = jb ? (size_t)(*env)->GetArrayLength(env, jb) : 0;
    }
  }
  hbcpack_options opts = { dicts, ndicts, 0 };
  uint8_t *out = NULL; size_t out_len = 0;
  hbcpack_status st = hbcpack_unpack((const uint8_t *)in, (size_t)in_len, &opts, &out, &out_len);
  (*env)->ReleaseByteArrayElements(env, packed, in, JNI_ABORT);
  for (size_t i = 0; i < ndicts; i++) {
    if (dict_elems && dict_elems[i]) { jbyteArray jb = (jbyteArray)(*env)->GetObjectArrayElement(env, dictData, (jsize)i); (*env)->ReleaseByteArrayElements(env, jb, dict_elems[i], JNI_ABORT); }
    if (dict_names) free(dict_names[i]);
  }
  free(dicts); free(dict_elems); free(dict_names);
  if (st != HBCPACK_OK) { throw_iae(env, hbcpack_strerror(st)); return NULL; }
  jbyteArray result = (*env)->NewByteArray(env, (jsize)out_len);
  if (result) (*env)->SetByteArrayRegion(env, result, 0, (jsize)out_len, (const jbyte *)out);
  hbcpack_free(out);
  return result;
}

JNIEXPORT jlong JNICALL Java_com_kodespire_hbcpack_HbcPack_unpackedSize(JNIEnv *env, jclass cls, jbyteArray packed) {
  (void)cls;
  if (!packed) { throw_iae(env, "packed is null"); return 0; }
  jsize in_len = (*env)->GetArrayLength(env, packed);
  jbyte *in = (*env)->GetByteArrayElements(env, packed, NULL);
  size_t size = 0;
  hbcpack_status st = hbcpack_unpacked_size((const uint8_t *)in, (size_t)in_len, NULL, &size);
  (*env)->ReleaseByteArrayElements(env, packed, in, JNI_ABORT);
  if (st != HBCPACK_OK) { throw_iae(env, hbcpack_strerror(st)); return 0; }
  return (jlong)size;
}

JNIEXPORT jstring JNICALL Java_com_kodespire_hbcpack_HbcPack_nativeVersion(JNIEnv *env, jclass cls) {
  (void)cls;
  return (*env)->NewStringUTF(env, HBCPACK_VERSION);
}
