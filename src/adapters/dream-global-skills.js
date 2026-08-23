import { canonicalJson } from '../core/canonical-json.js';
import { sha256Bytes } from '../core/hash.js';

const ASSET_BUNDLE_VERSION = 1;
const USER_FILE_PREFIX = '/user/files/';
const GLOBAL_SKILL_REGISTRY_PREFIX = 'global-skill:';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireSafeName(name) {
  if (
    typeof name !== 'string'
    || name.trim() === ''
    || name === '.'
    || name === '..'
    || /[\\/]/u.test(name)
  ) {
    throw new TypeError('Dream creator global Skill asset has an unsafe filename');
  }
  return name;
}

function filenameFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(USER_FILE_PREFIX)) {
    throw new TypeError('Dream creator global Skill files must use /user/files/ URLs');
  }
  const name = url.slice(USER_FILE_PREFIX.length);
  return requireSafeName(name);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== 'string') throw new TypeError('Dream creator Skill asset data must be base64 text');
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError('Dream creator Skill asset data is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mainRegistryKey(skillId) {
  return `${GLOBAL_SKILL_REGISTRY_PREFIX}${skillId}:SKILL.md`;
}

function resourceRegistryKey(skillId, path) {
  return `${GLOBAL_SKILL_REGISTRY_PREFIX}${skillId}:${path}`;
}

function registryName(settings, key, fallbackUrl) {
  const name = settings?.files?.[key]?.name;
  return typeof name === 'string' && name.trim() ? requireSafeName(name) : filenameFromUrl(fallbackUrl);
}

function logicalSkillEntry(entry) {
  if (!isPlainObject(entry)) throw new TypeError('Dream creator global Skill index entry is invalid');
  const next = clone(entry);
  delete next.url;
  if (isPlainObject(next.files)) {
    for (const file of Object.values(next.files)) {
      if (!isPlainObject(file)) throw new TypeError('Dream creator global Skill resource entry is invalid');
      delete file.url;
    }
  }
  return next;
}

export function portableGlobalSkills(settings) {
  if (!isPlainObject(settings?.globalSkills)) return {};
  return Object.fromEntries(
    Object.entries(settings.globalSkills).map(([skillId, entry]) => [skillId, logicalSkillEntry(entry)]),
  );
}

async function captureAsset(host, { name, url, expectedSha256 = null }) {
  if (typeof host.files?.download !== 'function') {
    throw new Error('Bridge user-file host is unavailable for Dream creator Skill capture');
  }
  filenameFromUrl(url);
  const bytes = await host.files.download(url);
  const sha256 = await sha256Bytes(bytes);
  if (expectedSha256 && isSha256(expectedSha256) && sha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Dream creator global Skill file hash mismatch: ${name}`);
  }
  return {
    name: requireSafeName(name),
    sha256,
    size: bytes.byteLength,
    data: bytesToBase64(bytes),
  };
}

export async function captureGlobalSkillAssets(host, settings) {
  const skills = {};
  const globalSkills = isPlainObject(settings?.globalSkills) ? settings.globalSkills : {};
  let totalBytes = 0;
  let fileCount = 0;

  for (const [skillId, entry] of Object.entries(globalSkills)) {
    if (!isPlainObject(entry) || entry.id !== skillId || typeof entry.url !== 'string') {
      throw new TypeError(`Dream creator global Skill index is invalid: ${skillId}`);
    }
    const main = await captureAsset(host, {
      name: registryName(settings, mainRegistryKey(skillId), entry.url),
      url: entry.url,
      expectedSha256: entry.sha256,
    });
    totalBytes += main.size;
    fileCount += 1;

    const files = {};
    for (const [path, file] of Object.entries(isPlainObject(entry.files) ? entry.files : {})) {
      if (!isPlainObject(file) || file.path !== path || typeof file.url !== 'string') {
        throw new TypeError(`Dream creator global Skill resource index is invalid: ${skillId}:${path}`);
      }
      const asset = await captureAsset(host, {
        name: registryName(settings, resourceRegistryKey(skillId, path), file.url),
        url: file.url,
        expectedSha256: file.sha256,
      });
      files[path] = asset;
      totalBytes += asset.size;
      fileCount += 1;
    }
    skills[skillId] = { main, files };
  }

  return {
    version: ASSET_BUNDLE_VERSION,
    skills,
    fileCount,
    totalBytes,
  };
}

function validateAsset(asset, label) {
  if (!isPlainObject(asset)) throw new TypeError(`Dream creator Skill asset is invalid: ${label}`);
  requireSafeName(asset.name);
  if (!isSha256(asset.sha256)) throw new TypeError(`Dream creator Skill asset hash is invalid: ${label}`);
  if (!Number.isInteger(asset.size) || asset.size < 0) {
    throw new TypeError(`Dream creator Skill asset size is invalid: ${label}`);
  }
  if (typeof asset.data !== 'string') throw new TypeError(`Dream creator Skill asset data is invalid: ${label}`);
}

export function validateGlobalSkillAssets(bundle, portableSettings) {
  if (!isPlainObject(bundle) || bundle.version !== ASSET_BUNDLE_VERSION || !isPlainObject(bundle.skills)) {
    throw new TypeError('Dream creator global Skill asset bundle is invalid');
  }
  const expectedSkills = isPlainObject(portableSettings?.globalSkills) ? portableSettings.globalSkills : {};
  const expectedIds = Object.keys(expectedSkills).sort();
  const actualIds = Object.keys(bundle.skills).sort();
  if (canonicalJson(expectedIds) !== canonicalJson(actualIds)) {
    throw new TypeError('Dream creator global Skill asset coverage does not match settings');
  }

  for (const skillId of expectedIds) {
    const entry = expectedSkills[skillId];
    const assets = bundle.skills[skillId];
    if (!isPlainObject(entry) || !isPlainObject(assets) || !isPlainObject(assets.files)) {
      throw new TypeError(`Dream creator global Skill asset bundle is invalid: ${skillId}`);
    }
    validateAsset(assets.main, `${skillId}:SKILL.md`);
    const expectedPaths = Object.keys(isPlainObject(entry.files) ? entry.files : {}).sort();
    const actualPaths = Object.keys(assets.files).sort();
    if (canonicalJson(expectedPaths) !== canonicalJson(actualPaths)) {
      throw new TypeError(`Dream creator global Skill resource coverage does not match settings: ${skillId}`);
    }
    for (const path of expectedPaths) validateAsset(assets.files[path], `${skillId}:${path}`);
  }
}

async function decodedAsset(asset, label) {
  validateAsset(asset, label);
  const bytes = base64ToBytes(asset.data);
  if (bytes.byteLength !== asset.size) throw new Error(`Dream creator Skill asset size mismatch: ${label}`);
  const sha256 = await sha256Bytes(bytes);
  if (sha256 !== asset.sha256.toLowerCase()) throw new Error(`Dream creator Skill asset hash mismatch: ${label}`);
  return bytes;
}

async function fileHealthy(host, url, asset, label) {
  if (typeof url !== 'string' || !url.startsWith(USER_FILE_PREFIX) || typeof host.files?.download !== 'function') return false;
  try {
    const bytes = await host.files.download(url);
    if (bytes.byteLength !== asset.size) return false;
    return (await sha256Bytes(bytes)) === asset.sha256.toLowerCase();
  } catch {
    return false;
  }
}

export async function globalSkillAssetsHealthy(host, currentSettings, portableSettings, bundle) {
  validateGlobalSkillAssets(bundle, portableSettings);
  const currentSkills = isPlainObject(currentSettings?.globalSkills) ? currentSettings.globalSkills : {};
  for (const [skillId, sourceEntry] of Object.entries(portableSettings.globalSkills ?? {})) {
    const currentEntry = currentSkills[skillId];
    const assets = bundle.skills[skillId];
    if (!isPlainObject(currentEntry)) return false;
    if (!(await fileHealthy(host, currentEntry.url, assets.main, `${skillId}:SKILL.md`))) return false;
    for (const path of Object.keys(sourceEntry.files ?? {})) {
      const currentFile = currentEntry.files?.[path];
      if (!isPlainObject(currentFile)) return false;
      if (!(await fileHealthy(host, currentFile.url, assets.files[path], `${skillId}:${path}`))) return false;
    }
  }
  return true;
}

async function resolveAssetUrl(host, existingUrl, asset, label, uploadedUrls) {
  if (await fileHealthy(host, existingUrl, asset, label)) return existingUrl;
  if (typeof host.files?.upload !== 'function') {
    throw new Error('Bridge user-file host is unavailable for Dream creator Skill restore');
  }
  const bytes = await decodedAsset(asset, label);
  const url = await host.files.upload(asset.name, bytes);
  if (typeof url !== 'string' || !url.startsWith(USER_FILE_PREFIX)) {
    throw new Error(`Dream creator Skill upload returned an invalid URL: ${label}`);
  }
  uploadedUrls.push(url);
  return url;
}

export async function materializeGlobalSkills(host, currentSettings, portableSettings, bundle) {
  validateGlobalSkillAssets(bundle, portableSettings);
  const restored = clone(portableSettings);
  const currentSkills = isPlainObject(currentSettings?.globalSkills) ? currentSettings.globalSkills : {};
  const files = isPlainObject(currentSettings?.files) ? clone(currentSettings.files) : {};
  for (const key of Object.keys(files)) {
    if (key.startsWith(GLOBAL_SKILL_REGISTRY_PREFIX)) delete files[key];
  }

  const uploadedUrls = [];
  try {
    const hydratedSkills = {};
    for (const [skillId, sourceEntry] of Object.entries(restored.globalSkills ?? {})) {
      const assets = bundle.skills[skillId];
      const currentEntry = currentSkills[skillId];
      const hydrated = clone(sourceEntry);
      const mainUrl = await resolveAssetUrl(
        host,
        currentEntry?.url,
        assets.main,
        `${skillId}:SKILL.md`,
        uploadedUrls,
      );
      hydrated.url = mainUrl;
      files[mainRegistryKey(skillId)] = {
        bindingId: 'global',
        createdAt: Date.now(),
        name: assets.main.name,
        size: assets.main.size,
        url: mainUrl,
      };

      const hydratedFiles = {};
      for (const [path, sourceFile] of Object.entries(sourceEntry.files ?? {})) {
        const asset = assets.files[path];
        const url = await resolveAssetUrl(
          host,
          currentEntry?.files?.[path]?.url,
          asset,
          `${skillId}:${path}`,
          uploadedUrls,
        );
        hydratedFiles[path] = { ...clone(sourceFile), url };
        files[resourceRegistryKey(skillId, path)] = {
          bindingId: 'global',
          createdAt: Date.now(),
          name: asset.name,
          size: asset.size,
          url,
        };
      }
      hydrated.files = hydratedFiles;
      hydratedSkills[skillId] = hydrated;
    }
    restored.globalSkills = hydratedSkills;
    restored.files = files;
    return { settings: restored, uploadedUrls };
  } catch (error) {
    if (typeof host.files?.delete === 'function') {
      for (const url of uploadedUrls) await host.files.delete(url).catch(() => undefined);
    }
    throw error;
  }
}
