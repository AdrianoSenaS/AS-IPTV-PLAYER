const appJson = require('./app.json');

module.exports = () => {
  const config = appJson.expo;

  return {
    ...config,
    plugins: [...(config.plugins || []), require('./plugins/with-android-release-config')],
  };
};