const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const iabTcfCommonJsEntry = require.resolve('@iabtcf/core')

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // @iabtcf/core 1.5.6 publishes an ESM index that references a type-only
  // EncodingOptions.js file which is absent from the package. Its CommonJS
  // build includes the required empty runtime module and is functionally
  // equivalent, so resolve only this package through the valid entry point.
  if (moduleName === '@iabtcf/core') {
    return { type: 'sourceFile', filePath: iabTcfCommonJsEntry }
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
