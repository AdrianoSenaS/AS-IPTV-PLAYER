const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
} = require('expo/config-plugins');

const TV_BANNER_DRAWABLE_NAME = 'tv_app_banner';
const TV_BANNER_SOURCE = path.join('assets', 'images', 'tv-banner-320x180.png');

function readInfoFile(projectRoot) {
  const infoPath = path.join(projectRoot, 'info.txt');
  if (!fs.existsSync(infoPath)) {
    return '';
  }

  return fs.readFileSync(infoPath, 'utf8');
}

function extractValue(source, key) {
  const pattern = new RegExp(`^${key}=(.+)$`, 'm');
  const match = source.match(pattern);
  return match ? match[1].trim() : '';
}

function extractVersionCode(source, fallback) {
  const patterns = [
    /^(?:VERSION_CODE|versionCode)\s*=\s*(\d+)$/mi,
    /^codigo(?:\s+da)?\s+versao\s*=\s*(\d+)$/mi,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }

  return Number(fallback || 1);
}

function ensureTvBannerDrawable(projectRoot) {
  const sourcePath = path.join(projectRoot, TV_BANNER_SOURCE);
  const drawableDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'drawable-nodpi');
  const drawablePath = path.join(drawableDir, `${TV_BANNER_DRAWABLE_NAME}.png`);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Banner de TV nao encontrado em ${sourcePath}`);
  }

  fs.mkdirSync(drawableDir, { recursive: true });
  fs.copyFileSync(sourcePath, drawablePath);
}

function ensureUsesFeature(manifest, name, required) {
  const features = manifest['uses-feature'] || [];
  const existing = features.find((entry) => entry.$['android:name'] === name);

  if (existing) {
    existing.$['android:required'] = required;
  } else {
    features.push({ $: { 'android:name': name, 'android:required': required } });
  }

  manifest['uses-feature'] = features;
}

function ensureLeanbackLauncherCategory(mainActivity) {
  const intentFilters = mainActivity['intent-filter'] || [];
  const launcherFilter = intentFilters.find((filter) => {
    const actions = filter.action || [];
    return actions.some((entry) => entry.$['android:name'] === 'android.intent.action.MAIN');
  });

  if (!launcherFilter) {
    intentFilters.push({
      action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.LAUNCHER' } },
        { $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } },
      ],
    });
    mainActivity['intent-filter'] = intentFilters;
    return;
  }

  launcherFilter.category = launcherFilter.category || [];
  const hasLeanback = launcherFilter.category.some(
    (entry) => entry.$['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER'
  );

  if (!hasLeanback) {
    launcherFilter.category.push({ $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } });
  }
}

function upsertGradleProperty(config, key, value) {
  if (!value) {
    return config;
  }

  const existing = config.modResults.find((entry) => entry.type === 'property' && entry.key === key);
  if (existing) {
    existing.value = value;
    return config;
  }

  config.modResults.push({ type: 'property', key, value });
  return config;
}

function ensureSigningConfigBlock(contents) {
  if (contents.includes('MYAPP_UPLOAD_STORE_FILE')) {
    return contents;
  }

  const signingBlock = `
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            if (project.hasProperty('MYAPP_UPLOAD_STORE_FILE')) {
                storeFile file(MYAPP_UPLOAD_STORE_FILE)
                storePassword MYAPP_UPLOAD_STORE_PASSWORD
                keyAlias MYAPP_UPLOAD_KEY_ALIAS
                keyPassword MYAPP_UPLOAD_KEY_PASSWORD
            }
        }
    }
`;

  return contents.replace(/(defaultConfig\s*\{[\s\S]*?\n    \})/, `$1\n${signingBlock}`);
}

function ensureReleaseSigning(contents) {
  let next = contents.replace(
    /release\s*\{([\s\S]*?)signingConfig signingConfigs\.debug/g,
    'release {$1signingConfig signingConfigs.release'
  );

  if (!/debug\s*\{[\s\S]*?signingConfig signingConfigs\.debug/.test(next)) {
    next = next.replace(
      /buildTypes\s*\{/,
      `buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }`
    );
  }

  if (!/release\s*\{[\s\S]*?signingConfig signingConfigs\.release/.test(next)) {
    next = next.replace(
      /release\s*\{/,
      `release {
            signingConfig signingConfigs.release`
    );
  }

  return next;
}

function ensureVersionConfig(contents, config, infoContents) {
  const versionCode = extractVersionCode(infoContents, config.android?.versionCode || 1);
  const versionName = config.version || '1.0.2';

  let next = contents.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
  next = next.replace(/versionName\s+"[^"]+"/, `versionName "${versionName}"`);
  return next;
}

module.exports = function withAndroidReleaseConfig(config) {
  const infoContents = readInfoFile(config._internal?.projectRoot || process.cwd());

  config = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      ensureTvBannerDrawable(modConfig.modRequest.projectRoot);
      return modConfig;
    },
  ]);

  config = withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest;
    const application = manifest.application?.[0];
    const mainActivity = application?.activity?.find(
      (activity) => activity.$['android:name'] === '.MainActivity'
    );

    ensureUsesFeature(manifest, 'android.software.leanback', 'false');
    ensureUsesFeature(manifest, 'android.hardware.touchscreen', 'false');


    if (application) {
      application.$['android:banner'] = `@drawable/${TV_BANNER_DRAWABLE_NAME}`;
      // Garante que android:largeHeap="true" sempre será aplicado
      application.$['android:largeHeap'] = 'true';
    }

    if (mainActivity) {
      ensureLeanbackLauncherCategory(mainActivity);
    }

    return manifestConfig;
  });

  config = withGradleProperties(config, (gradleConfig) => {
    const entries = {
      MYAPP_UPLOAD_STORE_FILE: extractValue(infoContents, 'MYAPP_UPLOAD_STORE_FILE'),
      MYAPP_UPLOAD_KEY_ALIAS: extractValue(infoContents, 'MYAPP_UPLOAD_KEY_ALIAS'),
      MYAPP_UPLOAD_STORE_PASSWORD: extractValue(infoContents, 'MYAPP_UPLOAD_STORE_PASSWORD'),
      MYAPP_UPLOAD_KEY_PASSWORD: extractValue(infoContents, 'MYAPP_UPLOAD_KEY_PASSWORD'),
    };

    Object.entries(entries).forEach(([key, value]) => {
      upsertGradleProperty(gradleConfig, key, value);
    });

    return gradleConfig;
  });

  config = withAppBuildGradle(config, (gradleConfig) => {
    let contents = gradleConfig.modResults.contents;
    contents = ensureSigningConfigBlock(contents);
    contents = ensureReleaseSigning(contents);
    contents = ensureVersionConfig(contents, config, infoContents);
    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });

  return config;
};