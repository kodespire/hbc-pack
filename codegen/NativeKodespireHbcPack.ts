// Declares the native module for React Native's codegen, which registers it with the app
// (see codegenConfig in package.json). Nothing imports this file: the module is written by
// hand in cpp/KodespireHbcPackModule.cpp, and src/react-native.js is its JavaScript side.
// Byte arrays are typed as Object because codegen has no Uint8Array.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  version(): string;
  unpackSync(packed: Object, dictNames: Array<string> | null, dictData: Array<Object> | null): Object;
  unpack(packed: Object, dictNames: Array<string> | null, dictData: Array<Object> | null): Promise<Object>;
  unpackedSize(packed: Object): number;
}

export default TurboModuleRegistry.get<Spec>('KodespireHbcPack');
