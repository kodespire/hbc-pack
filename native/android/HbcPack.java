package com.kodespire.hbcpack;

/**
 * Java binding for the hbc-pack native decoder (libhbcpack.so, built by native/build-mobile.sh
 * with native/android/hbcpack_jni.c).
 *
 * <pre>
 *   byte[] hbc = HbcPack.unpack(packedBytes);                 // no dictionaries
 *   byte[] hbc = HbcPack.unpack(packedBytes, names, datas);   // with per-stream dictionaries
 * </pre>
 */
public final class HbcPack {
  static {
    System.loadLibrary("hbcpack");
  }

  private HbcPack() {}

  /** Decodes an hbc-pack container. Throws IllegalArgumentException on malformed input. */
  public static byte[] unpack(byte[] packed) {
    return unpack(packed, null, null);
  }

  /**
   * Decodes with dictionaries: {@code dictNames[i]} is the stream name (see FORMAT.md) that
   * {@code dictData[i]} applies to.
   */
  public static native byte[] unpack(byte[] packed, String[] dictNames, byte[][] dictData);

  /** Size of the decoded file, from the container header, without decoding the rest. */
  public static native long unpackedSize(byte[] packed);

  /** Version string of the native library. */
  public static native String nativeVersion();
}
