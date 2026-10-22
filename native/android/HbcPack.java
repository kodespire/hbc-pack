package com.kodespire.hbcpack;

/**
 * Java binding for the hbc-pack native decoder (libhbcpack.so, built by native/build-mobile.sh
 * with native/android/hbcpack_jni.c).
 *
 * <pre>
 *   byte[] hbc = HbcPack.unpack(packedBytes);                 // no dictionaries
 *   byte[] hbc = HbcPack.unpack(packedBytes, names, datas);   // with per-stream dictionaries
 *   byte[] hbc = HbcPack.unpackDelta(packedBytes, installed); // delta container + the installed .hbc
 * </pre>
 */
public final class HbcPack {
  static {
    System.loadLibrary("hbcpack");
  }

  private HbcPack() {}

  /** Decodes an hbc-pack container. Throws IllegalArgumentException on malformed input. */
  public static byte[] unpack(byte[] packed) {
    return unpack(packed, null, null, null);
  }

  /**
   * Decodes with dictionaries: {@code dictNames[i]} is the stream name (see FORMAT.md) that
   * {@code dictData[i]} applies to.
   */
  public static byte[] unpack(byte[] packed, String[] dictNames, byte[][] dictData) {
    return unpack(packed, dictNames, dictData, null);
  }

  /**
   * Decodes a delta container (FORMAT.md, container version 3): {@code base} is the installed
   * .hbc the container was made against. Throws if it is not that file.
   */
  public static byte[] unpackDelta(byte[] packed, byte[] base) {
    return unpack(packed, null, null, base);
  }

  /** All options; {@code dictNames}/{@code dictData} and {@code base} may be null. */
  public static native byte[] unpack(byte[] packed, String[] dictNames, byte[][] dictData, byte[] base);

  /** Size of the decoded file, from the container header, without decoding the rest. */
  public static long unpackedSize(byte[] packed) {
    return unpackedSize(packed, null);
  }

  /** Same, for a delta container ({@code base} may be null for self-contained containers). */
  public static native long unpackedSize(byte[] packed, byte[] base);

  /** Version string of the native library. */
  public static native String nativeVersion();
}
