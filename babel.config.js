module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Jest runs on CommonJS and can't execute real dynamic import() — Metro handles it fine in
    // the app itself, so this only kicks in under `test` (NODE_ENV=test, set by jest-expo).
    env: {
      test: {
        plugins: ['babel-plugin-dynamic-import-node'],
      },
    },
  };
};
