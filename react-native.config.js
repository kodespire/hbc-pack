// React Native autolinking. The module is C++, so Android links it through CMake rather
// than a Java module; iOS uses KodespireHbcPack.podspec. ES module syntax because this
// package is "type": "module"; the React Native CLI and Expo both read the default export.
export default {
  dependency: {
    platforms: {
      android: {
        cxxModuleCMakeListsModuleName: 'kodespire_hbcpack',
        cxxModuleCMakeListsPath: 'CMakeLists.txt',
        cxxModuleHeaderName: 'KodespireHbcPackModule',
      },
    },
  },
};
