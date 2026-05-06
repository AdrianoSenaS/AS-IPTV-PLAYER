/**
 * AS-IPTV Server
 *
 * APIs:
 * - realtime presence/session lock (REST)
 * - auth/account (register/login/profile)
 * - subscription plan state
 * - cloud sync prefs + backups
 * - admin dashboard endpoints
 *
 * Persistence: SQLite via better-sqlite3
 */

'use strict';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const Database = require('better-sqlite3');

const app = express();
const httpServer = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'as-iptv-rt-secret-change-in-prod';
const ADMIN_BOOTSTRAP_TOKEN = process.env.ADMIN_TOKEN || 'as-admin-123';
const PORT = Number(process.env.PORT || 3001);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'as-iptv.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVATAR_UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'avatars');
const HLS_PROXY_ROOT_DIR = path.join(DATA_DIR, 'proxy-hls');
const HLS_PIPELINE_TTL_MS = 120 * 1000;
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFMPEG_EVENT_LOG_LIMIT = 800;
const HLS_QUALITY_PROFILES = {
  auto: {
    key: 'auto',
    label: 'Auto',
    mode: 'copy',
    bandwidth: 2_800_000,
    averageBandwidth: 2_100_000,
    resolution: '1280x720',
  },
  high: {
    key: 'high',
    label: 'Alta',
    mode: 'transcode',
    height: 1080,
    videoBitrate: '3600k',
    maxRate: '4200k',
    bufSize: '7200k',
    audioBitrate: '160k',
    bandwidth: 4_200_000,
    averageBandwidth: 3_400_000,
    resolution: '1920x1080',
  },
  medium: {
    key: 'medium',
    label: 'Media',
    mode: 'transcode',
    height: 720,
    videoBitrate: '2100k',
    maxRate: '2600k',
    bufSize: '4200k',
    audioBitrate: '128k',
    bandwidth: 2_600_000,
    averageBandwidth: 2_000_000,
    resolution: '1280x720',
  },
  low: {
    key: 'low',
    label: 'Baixa',
    mode: 'transcode',
    height: 480,
    videoBitrate: '900k',
    maxRate: '1200k',
    bufSize: '1800k',
    audioBitrate: '96k',
    bandwidth: 1_200_000,
    averageBandwidth: 900_000,
    resolution: '854x480',
  },
};

const DEFAULT_FFMPEG_RUNTIME_CONFIG = {
  enabled: true,
  copyThreads: 1,
  transcodeThreads: 2,
  preset: 'ultrafast',
  tune: 'zerolatency',
  videoProfile: 'baseline',
  videoLevel: '3.1',
  probeSize: 5_000_000,
  analyzeDuration: 2_000_000,
  multipleRequests: true,
  httpPersistent: true,
  defaultLowLatencyLive: true,
  defaultAggressiveReconnect: true,
  liveHlsTimeFast: 2,
  liveHlsListFast: 10,
  liveHlsTimeSafe: 4,
  liveHlsListSafe: 10,
  vodHlsTime: 4,
  vodHlsListSize: 0,
  pipelineTtlMs: HLS_PIPELINE_TTL_MS,
};

const ffmpegEventLogs = [];
let ffmpegRuntimeConfig = { ...DEFAULT_FFMPEG_RUNTIME_CONFIG };

const PLAN_IDS = ['free', 'plus', 'pro', 'ultra', 'lifetime'];
const PLAN_LABELS = {
  free: 'Start',
  plus: 'Plus',
  pro: 'Pro',
  ultra: 'Ultra',
  lifetime: 'Lifetime',
};
const PLAN_FEATURE_IDS = [
  'explore',
  'downloads',
  'lists',
  'cast_mirror',
  'pip',
  'airplay',
  'recommendation_algorithm',
  'tmdb_details',
  'parental_controls',
  'realtime_monitor',
  'multi_server',
  'multi_user',
  'content_4k',
  'network_proxy',
];
const DEFAULT_PLAN_CATALOG = [
  {
    id: 'free',
    name: 'Start',
    tagline: 'Comece gratuitamente',
    price: 'R$ 0',
    priceNote: 'Gratis para sempre',
    color: '#7F89A8',
    maxProfiles: 1,
    maxServers: 1,
    highlighted: false,
    enabled: true,
    sortOrder: 0,
    features: [],
  },
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'Mais liberdade no uso diario',
    price: 'R$ 9,90/mes',
    priceNote: 'Cobrado mensalmente',
    color: '#5DA9FF',
    maxProfiles: 1,
    maxServers: 1,
    highlighted: false,
    enabled: true,
    sortOrder: 10,
    features: ['explore', 'downloads', 'lists', 'cast_mirror', 'pip'],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Mais controle e melhor experiencia',
    price: 'R$ 19,90/mes',
    priceNote: 'Mais escolhido',
    color: '#FF8F3A',
    maxProfiles: 2,
    maxServers: 2,
    highlighted: true,
    enabled: true,
    sortOrder: 20,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip',
      'airplay',
      'recommendation_algorithm',
      'tmdb_details',
      'multi_server',
      'multi_user',
    ],
  },
  {
    id: 'ultra',
    name: 'Ultra',
    tagline: 'Experiencia completa sem limites',
    price: 'R$ 29,90/mes',
    priceNote: 'Cobrado mensalmente',
    color: '#FF3B30',
    maxProfiles: 6,
    maxServers: -1,
    highlighted: false,
    enabled: true,
    sortOrder: 30,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip',
      'airplay',
      'recommendation_algorithm',
      'tmdb_details',
      'parental_controls',
      'realtime_monitor',
      'multi_server',
      'multi_user',
      'content_4k',
      'network_proxy',
    ],
  },
  {
    id: 'lifetime',
    name: 'Lifetime',
    tagline: 'Pague uma vez e desbloqueie tudo',
    price: 'R$ 199,90',
    priceNote: 'Pagamento unico',
    color: '#2CD07F',
    maxProfiles: -1,
    maxServers: -1,
    highlighted: false,
    enabled: true,
    sortOrder: 40,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip',
      'airplay',
      'recommendation_algorithm',
      'tmdb_details',
      'parental_controls',
      'realtime_monitor',
      'multi_server',
      'multi_user',
      'content_4k',
      'network_proxy',
    ],
  },
];

const DEFAULT_SUBSCRIPTION_PAGE_CONTENT = {
  triggers: [
    { icon: 'bolt', text: 'Use seu proprio conteudo com desempenho e organizacao' },
    { icon: 'hd', text: 'Recursos avancados de reproducao (incluindo 4K)' },
    { icon: 'download', text: 'Baixe para assistir offline quando quiser' },
    { icon: 'auto-awesome', text: 'Recomendacoes inteligentes com seu historico' },
    { icon: 'cast', text: 'Espelhamento e transmissao para TV' },
    { icon: 'shield', text: 'Controle parental e monitoramento em tempo real' },
    { icon: 'picture-in-picture-alt', text: 'PiP para continuar assistindo em miniatura' },
    { icon: 'group', text: 'Perfis e servidores extras para toda a familia' },
  ],
  featureLabels: {
    explore: { label: 'Explorar', icon: 'explore', desc: 'Navegacao inteligente para encontrar rapido o conteudo que voce ja possui' },
    downloads: { label: 'Downloads offline', icon: 'download', desc: 'Baixe conteudo para assistir sem internet' },
    lists: { label: 'Minhas listas', icon: 'playlist-add', desc: 'Crie e organize listas personalizadas do seu jeito' },
    cast_mirror: { label: 'Espelhar na TV', icon: 'cast', desc: 'Envie a reproducao para TV com Google Cast ou AirPlay' },
    pip: { label: 'Picture-in-Picture', icon: 'picture-in-picture-alt', desc: 'Continue assistindo enquanto usa outros apps' },
    airplay: { label: 'AirPlay', icon: 'airplay', desc: 'Streaming direto para Apple TV e dispositivos AirPlay' },
    recommendation_algorithm: { label: 'Recomendacoes IA', icon: 'auto-awesome', desc: 'Algoritmo aprende seu gosto e sugere o que voce vai amar' },
    tmdb_details: { label: 'Elenco & detalhes', icon: 'stars', desc: 'Elenco, nota, sinopse e informacoes completas via TMDB' },
    parental_controls: { label: 'Controle dos pais', icon: 'shield', desc: 'Bloqueio por categoria, PIN por perfil e modo infantil' },
    realtime_monitor: { label: 'Monitor em tempo real', icon: 'monitor', desc: 'Veja em tempo real o que seus filhos estao assistindo' },
    multi_server: { label: 'Multi-servidor', icon: 'dns', desc: 'Cadastre varios servidores e alterne sem perder historico' },
    multi_user: { label: 'Multi-perfis', icon: 'group', desc: 'Perfis separados com historico e preferencias proprias' },
    content_4k: { label: 'Reproducao 4K', icon: 'hd', desc: 'Recursos de reproducao e interface otimizados para conteudo 4K' },
    network_proxy: { label: 'Proxy de rede', icon: 'vpn_lock', desc: 'Roteia o video pelo servidor para contornar bloqueios de rede e VPN' },
  },
  compareOrder: [...PLAN_FEATURE_IDS],
};

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR));

function logAuth(event, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  console.log(`[AUTH][${nowIso()}] ${event}`, data);
  pushAdminAudit(`AUTH_${event}`, data);
}

const adminAuditLogs = [];
const ADMIN_AUDIT_LOG_LIMIT = 700;

// ─── Proxy Sessions ───────────────────────────────────────────────────────────
// Map sessionId → { userId, username, profileName, url, contentType, startedAt, lastSeenAt, bytesProxied }
const proxyActiveSessions = new Map();
const PROXY_SESSION_TTL_MS = 90 * 1000; // sessão expirada se sem heartbeat por 90s
const proxyHlsPipelines = new Map();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function clearHlsArtifacts(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath)) {
      const safeName = String(entry || '');
      if (!safeName) continue;
      if (!/\.(m3u8|ts)$/i.test(safeName)) continue;
      const fp = path.join(dirPath, safeName);
      try {
        fs.unlinkSync(fp);
      } catch {
        // ignora falhas pontuais de limpeza
      }
    }
  } catch {
    // ignora falha de listagem do diretório
  }
}

function getHlsDirSnapshot(dirPath, limit = 24) {
  try {
    if (!fs.existsSync(dirPath)) {
      return { exists: false, files: [] };
    }
    const files = fs
      .readdirSync(dirPath)
      .filter((name) => /\.(m3u8|ts)$/i.test(String(name || '')))
      .slice(0, limit);
    return { exists: true, files };
  } catch {
    return { exists: true, files: [] };
  }
}

function safePipelineHash(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 20);
}

function killPipelineProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignora
  }
}

function disposeProxyHlsPipeline(id) {
  const item = proxyHlsPipelines.get(id);
  if (!item) return;

  killPipelineProcess(item.proc);
  try {
    fs.rmSync(item.dirPath, { recursive: true, force: true });
  } catch {
    // ignora limpeza de diretório
  }

  proxyHlsPipelines.delete(id);
}

function isTsLikeTarget(urlValue) {
  const safe = String(urlValue || '').trim();
  if (!safe) return false;

  let inspect = safe;
  try {
    const wrapped = new URL(safe);
    const inner = wrapped.searchParams.get('url');
    if (inner) inspect = decodeURIComponent(inner);
  } catch {
    // usa URL original
  }

  return /\/ts(\?|$)/i.test(inspect) || /\.ts(\?|$)/i.test(inspect) || /[?&]output=ts(\b|&|$)/i.test(inspect);
}

async function resolveEffectiveHlsContentType(targetUrl, requestedType) {
  const normalizedType = /^vod$/i.test(String(requestedType || '').trim()) ? 'vod' : 'live';
  if (normalizedType !== 'vod') {
    return { requestedType: normalizedType, effectiveType: 'live', reason: 'requested-live' };
  }

  if (isTsLikeTarget(targetUrl)) {
    return { requestedType: normalizedType, effectiveType: 'live', reason: 'ts-like-url' };
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const response = await fetch(targetUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 AS-IPTV/1.0' },
      signal: ctrl.signal,
    }).catch(() =>
      fetch(targetUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 AS-IPTV/1.0', Range: 'bytes=0-1023' },
        signal: ctrl.signal,
      })
    );
    clearTimeout(timer);

    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    if (
      contentType.includes('application/octet-stream') ||
      contentType.includes('video/mp2t') ||
      contentType.includes('mpegts') ||
      contentType.includes('mp2t')
    ) {
      return { requestedType: normalizedType, effectiveType: 'live', reason: `content-type:${contentType || 'unknown'}` };
    }
  } catch {
    // Se o probe falhar, preserva o comportamento pedido pelo cliente.
  }

  return { requestedType: normalizedType, effectiveType: 'vod', reason: 'requested-vod' };
}

function waitForFileReady(filePath, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      fs.stat(filePath, (err, stats) => {
        if (!err && stats && stats.isFile() && stats.size > 0) {
          return resolve(true);
        }

        if (Date.now() - startedAt >= timeoutMs) {
          return reject(new Error('Manifesto HLS nao ficou pronto a tempo.'));
        }

        setTimeout(check, 220);
      });
    };

    check();
  });
}

function hasPlayableMediaEntries(manifestText) {
  const lines = String(manifestText || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean);

  if (!lines.some((line) => /^#EXTM3U$/i.test(line))) {
    return false;
  }

  let hasExtinf = false;
  let hasMediaUri = false;

  for (const line of lines) {
    if (/^#EXTINF:/i.test(line)) {
      hasExtinf = true;
      continue;
    }

    if (!line.startsWith('#')) {
      hasMediaUri = true;
    }
  }

  // Exige ao menos um bloco de segmento (EXTINF + URI) para evitar player zerado.
  return hasExtinf && hasMediaUri;
}

function waitForHlsManifestPlayable(manifestPath, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      fs.readFile(manifestPath, 'utf8', (err, content) => {
        if (!err && hasPlayableMediaEntries(content)) {
          return resolve(true);
        }

        if (Date.now() - startedAt >= timeoutMs) {
          return reject(new Error('Manifesto HLS pronto, mas sem segmentos de mídia para reprodução.'));
        }

        setTimeout(check, 260);
      });
    };

    check();
  });
}

function countManifestMediaSegments(manifestText) {
  return String(manifestText || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .length;
}

function waitForHlsManifestSegmentWarmup(manifestPath, minSegments = 2, timeoutMs = 12_000) {
  const safeMin = Math.max(1, Number(minSegments || 1));
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      fs.readFile(manifestPath, 'utf8', (err, content) => {
        if (!err && countManifestMediaSegments(content) >= safeMin) {
          return resolve(true);
        }

        if (Date.now() - startedAt >= timeoutMs) {
          return reject(new Error(`Manifesto HLS sem buffer minimo (${safeMin} segmentos).`));
        }

        setTimeout(check, 280);
      });
    };

    check();
  });
}

function normalizeHlsQualityParam(rawQuality) {
  const safe = String(rawQuality || '').trim().toLowerCase();
  if (safe === 'alta' || safe === 'high') return 'high';
  if (safe === 'media' || safe === 'medium') return 'medium';
  if (safe === 'baixa' || safe === 'low') return 'low';
  return 'auto';
}

function parseBooleanQuery(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return !!defaultValue;
  }
  const safe = String(value).trim().toLowerCase();
  if (safe === '1' || safe === 'true' || safe === 'yes' || safe === 'on') return true;
  if (safe === '0' || safe === 'false' || safe === 'no' || safe === 'off') return false;
  return !!defaultValue;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeFfmpegRuntimeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: parseBooleanQuery(source.enabled, DEFAULT_FFMPEG_RUNTIME_CONFIG.enabled),
    copyThreads: clampNumber(source.copyThreads, 1, 4, DEFAULT_FFMPEG_RUNTIME_CONFIG.copyThreads),
    transcodeThreads: clampNumber(source.transcodeThreads, 1, 16, DEFAULT_FFMPEG_RUNTIME_CONFIG.transcodeThreads),
    preset: String(source.preset || DEFAULT_FFMPEG_RUNTIME_CONFIG.preset).trim() || DEFAULT_FFMPEG_RUNTIME_CONFIG.preset,
    tune: String(source.tune || DEFAULT_FFMPEG_RUNTIME_CONFIG.tune).trim() || DEFAULT_FFMPEG_RUNTIME_CONFIG.tune,
    videoProfile: String(source.videoProfile || DEFAULT_FFMPEG_RUNTIME_CONFIG.videoProfile).trim() || DEFAULT_FFMPEG_RUNTIME_CONFIG.videoProfile,
    videoLevel: String(source.videoLevel || DEFAULT_FFMPEG_RUNTIME_CONFIG.videoLevel).trim() || DEFAULT_FFMPEG_RUNTIME_CONFIG.videoLevel,
    probeSize: clampNumber(source.probeSize, 32_000, 64_000_000, DEFAULT_FFMPEG_RUNTIME_CONFIG.probeSize),
    analyzeDuration: clampNumber(source.analyzeDuration, 0, 30_000_000, DEFAULT_FFMPEG_RUNTIME_CONFIG.analyzeDuration),
    multipleRequests: parseBooleanQuery(source.multipleRequests, DEFAULT_FFMPEG_RUNTIME_CONFIG.multipleRequests),
    httpPersistent: parseBooleanQuery(source.httpPersistent, DEFAULT_FFMPEG_RUNTIME_CONFIG.httpPersistent),
    defaultLowLatencyLive: parseBooleanQuery(source.defaultLowLatencyLive, DEFAULT_FFMPEG_RUNTIME_CONFIG.defaultLowLatencyLive),
    defaultAggressiveReconnect: parseBooleanQuery(source.defaultAggressiveReconnect, DEFAULT_FFMPEG_RUNTIME_CONFIG.defaultAggressiveReconnect),
    liveHlsTimeFast: clampNumber(source.liveHlsTimeFast, 1, 12, DEFAULT_FFMPEG_RUNTIME_CONFIG.liveHlsTimeFast),
    liveHlsListFast: clampNumber(source.liveHlsListFast, 3, 20, DEFAULT_FFMPEG_RUNTIME_CONFIG.liveHlsListFast),
    liveHlsTimeSafe: clampNumber(source.liveHlsTimeSafe, 1, 20, DEFAULT_FFMPEG_RUNTIME_CONFIG.liveHlsTimeSafe),
    liveHlsListSafe: clampNumber(source.liveHlsListSafe, 4, 40, DEFAULT_FFMPEG_RUNTIME_CONFIG.liveHlsListSafe),
    vodHlsTime: clampNumber(source.vodHlsTime, 1, 20, DEFAULT_FFMPEG_RUNTIME_CONFIG.vodHlsTime),
    vodHlsListSize: clampNumber(source.vodHlsListSize, 0, 200_000, DEFAULT_FFMPEG_RUNTIME_CONFIG.vodHlsListSize),
    pipelineTtlMs: clampNumber(source.pipelineTtlMs, 30_000, 900_000, DEFAULT_FFMPEG_RUNTIME_CONFIG.pipelineTtlMs),
  };
}

function getFfmpegRuntimeConfig() {
  ffmpegRuntimeConfig = normalizeFfmpegRuntimeConfig(ffmpegRuntimeConfig);
  return ffmpegRuntimeConfig;
}

function updateFfmpegRuntimeConfig(partial) {
  const merged = {
    ...getFfmpegRuntimeConfig(),
    ...(partial && typeof partial === 'object' ? partial : {}),
  };
  ffmpegRuntimeConfig = normalizeFfmpegRuntimeConfig(merged);
  return ffmpegRuntimeConfig;
}

function pushFfmpegEvent(event, payload) {
  const row = {
    id: makeId('ffm-log'),
    ts: nowIso(),
    event: String(event || 'UNKNOWN'),
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  ffmpegEventLogs.unshift(row);
  if (ffmpegEventLogs.length > FFMPEG_EVENT_LOG_LIMIT) {
    ffmpegEventLogs.length = FFMPEG_EVENT_LOG_LIMIT;
  }
  return row;
}

function ensureProxyHlsPipeline(targetUrl, sid = '', quality = 'auto', contentType = 'live', options = {}) {
  ensureDataDir();
  ensureDir(HLS_PROXY_ROOT_DIR);
  const runtime = getFfmpegRuntimeConfig();
  if (runtime.enabled !== true) {
    throw new Error('Pipeline FFmpeg desativado no painel admin.');
  }

  const qualityKey = normalizeHlsQualityParam(quality);
  const profile = HLS_QUALITY_PROFILES[qualityKey] || HLS_QUALITY_PROFILES.auto;
  const isVod = String(contentType || 'live').startsWith('vod');
  const isLive = !isVod;
  const lowLatencyLive = parseBooleanQuery(options?.lowLatencyLive, runtime.defaultLowLatencyLive);
  const aggressiveReconnect = parseBooleanQuery(options?.aggressiveReconnect, runtime.defaultAggressiveReconnect);

  // pipelineId é baseado apenas em URL+quality+flags (sem sid) para que múltiplos
  // usuários/requests reutilizem o mesmo processo FFmpeg já aquecido.
  // O sid NÃO faz parte do id — inclui-lo causava cold start para cada request.
  const pipelineId = `${safePipelineHash(targetUrl)}-${qualityKey}${isVod ? '-vod' : ''}-${lowLatencyLive ? 'll1' : 'll0'}-${aggressiveReconnect ? 'ar1' : 'ar0'}`;
  const existing = proxyHlsPipelines.get(pipelineId);
  if (existing && existing.proc && !existing.proc.killed) {
    existing.lastSeenAt = Date.now();
    pushFfmpegEvent('HLS_PIPELINE_REUSE', {
      pipelineId,
      sid: String(sid || ''),
      quality: qualityKey,
      contentType: isVod ? 'vod' : 'live',
      lowLatencyLive,
      aggressiveReconnect,
    });
    return existing;
  }

  if (existing) {
    disposeProxyHlsPipeline(pipelineId);
  }

  const dirPath = path.join(HLS_PROXY_ROOT_DIR, pipelineId);
  ensureDir(dirPath);
  // Limpa artefatos de execuções anteriores para evitar segmentos TS "fantasma"
  // sem manifesto correspondente no novo start.
  clearHlsArtifacts(dirPath);

  const manifestPath = path.join(dirPath, `index_${qualityKey}.m3u8`);
  const segmentPattern = path.join(dirPath, `seg_${qualityKey}_%06d.ts`);
  try {
    // Escreve um manifesto bootstrap para facilitar diagnóstico em disco
    // enquanto o FFmpeg ainda inicializa.
    fs.writeFileSync(manifestPath, '#EXTM3U\n# AS-IPTV bootstrap manifest\n');
  } catch {
    // segue o fluxo mesmo se não conseguir escrever bootstrap
  }

  // Número de threads por pipeline configurável no admin
  const threadCount = String(profile.mode === 'copy' ? runtime.copyThreads : runtime.transcodeThreads);

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    // Para streams TS raw (octet-stream) reduzimos o probe drasticamente para
    // evitar delay de cold-start. O FFmpeg detecta o codec imediatamente nesses casos.
    '-probesize', isLive ? '200000' : String(runtime.probeSize),
    '-analyzeduration', isLive ? '200000' : String(runtime.analyzeDuration),
    // Headers amigáveis para o provedor
    '-user_agent', 'Mozilla/5.0 (AppleWebKit/537.36) AS-IPTV/1.0',
    '-headers', 'Accept: */*\r\n',
    '-fflags', '+genpts+igndts',
    '-avoid_negative_ts', 'make_zero',
    // Reconexao deve vir antes do -i para aplicar na entrada de rede
    ...(aggressiveReconnect
      ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '3']
      : []),
    // Download paralelo de segmentos do provedor (pré-fetch mais rápido)
    '-multiple_requests', runtime.multipleRequests ? '1' : '0',
    '-i', String(targetUrl),
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    // Limitar threads por pipeline para economizar CPU
    '-threads', threadCount,
  ];

  if (profile.mode === 'copy') {
    args.push('-c', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', String(runtime.preset),
      '-tune', String(runtime.tune),
      '-profile:v', String(runtime.videoProfile),
      '-level', String(runtime.videoLevel),
      '-vf', `scale=-2:${profile.height}`,
      '-b:v', String(profile.videoBitrate),
      '-maxrate', String(profile.maxRate),
      '-bufsize', String(profile.bufSize),
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      String(profile.audioBitrate),
      '-ac',
      '2',
      '-ar',
      '48000'
    );
  }

  if (isVod) {
    // VOD: playlist completa e tipada como VOD, garantindo seek/duracao corretos.
    args.push(
      '-f', 'hls',
      '-hls_time', String(runtime.vodHlsTime),
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', segmentPattern,
      manifestPath
    );
  } else {
    // Live/TV: janela deslizante.
    // NÃO usamos delete_segments — o Node.js faz limpeza com grace period (pruneOldHlsSegments).
    // NÃO usamos append_list — FFmpeg precisa reescrever o manifesto a cada segmento
    // para manter rolling window com EXT-X-MEDIA-SEQUENCE correto.
    const hlsTime = String(lowLatencyLive ? runtime.liveHlsTimeFast : runtime.liveHlsTimeSafe);
    const hlsListSize = String(lowLatencyLive ? runtime.liveHlsListFast : runtime.liveHlsListSafe);
    args.push(
      '-f', 'hls',
      '-hls_time', hlsTime,
      '-hls_list_size', hlsListSize,
      '-hls_flags', 'independent_segments+omit_endlist',
      '-hls_segment_filename', segmentPattern,
      manifestPath
    );
  }

  const proc = spawn(FFMPEG_BIN, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const state = {
    id: pipelineId,
    targetUrl: String(targetUrl),
    quality: qualityKey,
    contentType: isVod ? 'vod' : 'live',
    lowLatencyLive,
    aggressiveReconnect,
    dirPath,
    manifestPath,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    lastError: '',
    exitCode: null,
    proc,
    runtime: {
      copyThreads: runtime.copyThreads,
      transcodeThreads: runtime.transcodeThreads,
      preset: runtime.preset,
      tune: runtime.tune,
      probeSize: runtime.probeSize,
      analyzeDuration: runtime.analyzeDuration,
      multipleRequests: runtime.multipleRequests,
      httpPersistent: runtime.httpPersistent,
    },
  };

  pushFfmpegEvent('HLS_PIPELINE_START', {
    pipelineId,
    sid: String(sid || ''),
    quality: qualityKey,
    contentType: isVod ? 'vod' : 'live',
    lowLatencyLive,
    aggressiveReconnect,
    threadCount,
    mode: profile.mode,
    dirPath,
    manifestPath,
    segmentPattern,
  });

  proc.stderr?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) {
      state.lastError = text.slice(-1200);
      // Loga TUDO do stderr para visibilidade no painel admin
      pushFfmpegEvent('HLS_PIPELINE_STDERR', {
        pipelineId,
        quality: qualityKey,
        contentType: isVod ? 'vod' : 'live',
        isError: /error|failed|invalid|timed? out|404|403|401/i.test(text),
        message: text.slice(-800),
      });
    }
  });

  proc.on('exit', (code) => {
    state.exitCode = Number.isFinite(code) ? code : -1;
    pushFfmpegEvent('HLS_PIPELINE_EXIT', {
      pipelineId,
      quality: qualityKey,
      contentType: isVod ? 'vod' : 'live',
      exitCode: state.exitCode,
      lastError: state.lastError,
    });
    // VOD: quando o FFmpeg termina, o manifesto fica como VOD completo automaticamente
    // (hls_playlist_type event + fim do processo = EXT-X-ENDLIST gerado pelo ffmpeg)
  });

  proxyHlsPipelines.set(pipelineId, state);
  return state;
}

function pruneProxyHlsPipelines() {
  const now = Date.now();
  const runtime = getFfmpegRuntimeConfig();
  for (const [id, item] of proxyHlsPipelines.entries()) {
    const stale = now - Number(item.lastSeenAt || 0) > Number(runtime.pipelineTtlMs || HLS_PIPELINE_TTL_MS);
    const dead = !item.proc || item.proc.killed || item.exitCode !== null;
    if (stale || dead) {
      disposeProxyHlsPipeline(id);
    }
  }
}

function pruneProxySessions() {
  const cutoff = Date.now() - PROXY_SESSION_TTL_MS;
  for (const [id, s] of proxyActiveSessions) {
    if (s.lastSeenAt < cutoff) proxyActiveSessions.delete(id);
  }
}

function upsertProxySession(sessionId, data) {
  const existing = proxyActiveSessions.get(sessionId) || {};
  proxyActiveSessions.set(sessionId, {
    ...existing,
    ...data,
    lastSeenAt: Date.now(),
  });
  pruneProxySessions();
}

function pushAdminAudit(event, payload) {
  const next = {
    id: makeId('adm-log'),
    ts: nowIso(),
    event: String(event || 'UNKNOWN'),
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  adminAuditLogs.unshift(next);
  if (adminAuditLogs.length > ADMIN_AUDIT_LOG_LIMIT) {
    adminAuditLogs.length = ADMIN_AUDIT_LOG_LIMIT;
  }
}

// sessions[accountKey][profileId] = { ... }
const sessions = {};

// continueWatch[userId][profileId] = { items: [...], updatedAt: string }
const continueWatch = {};

// blockedContent[accountKey] = Set<contentId>
const blockedContent = {};

// parentalActivity[accountKey][profileId] = { searches, watchHistory, minutesByHour, activeWatchStart }
const parentalActivity = {};

// parentalRules[accountKey] = regras agressivas por conta/servidor
const parentalRules = {};

// REST-only mode: mantém assinatura compatível onde havia io.to(...).emit(...).
const io = {
  to() {
    return {
      emit() {
        // no-op
      },
    };
  },
};

const DEFAULT_PARENTAL_RULES = {
  aggressiveMode: false,
  autoBlockOnForbiddenSearch: true,
  criticalAlertsEnabled: true,
  progressivePenaltyEnabled: false,
  penaltyWindowMinutes: 180,
  step2BlockMinutes: 20,
  step3BlockMinutes: 120,
  forbiddenSearchKeywords: ['adult', '18+', 'porn', 'xxx', 'sexo'],
  maxMinutesPerHour: 90,
  maxContinuousMinutes: 120,
};

let eventLoopLagMs = 0;
let eventLoopLagLastTick = nowMs();

// pushTokens[accountKey][profileId] = expoToken
const pushTokens = {};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function safeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function makeId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function normalizePlanId(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return 'free';
  try {
    if (dbGetPlanCatalogById(candidate)) {
      return candidate;
    }
  } catch {
    // fallback para primeira carga
  }
  return PLAN_IDS.includes(candidate) ? candidate : 'free';
}

function normalizePlanStatus(value) {
  return value === 'active' || value === 'expired' || value === 'grace' ? value : 'unknown';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensurePublicDirs() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }
  if (!fs.existsSync(AVATAR_UPLOAD_DIR)) {
    fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
  }
}

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensurePublicDirs();
      cb(null, AVATAR_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext) ? ext : '.jpg';
      cb(null, `avatar-${req.userAuth?.userId || 'unknown'}-${Date.now()}${safeExt === '.jpeg' ? '.jpg' : safeExt}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// ---- SQLite setup -----------------------------------------------------------
let _db = null;

function getDb() {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  ensurePlanCatalogSeed();
  ensureSubscriptionPageConfigSeed();
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      avatar_uri    TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_plans (
      user_id        TEXT PRIMARY KEY,
      plan_id        TEXT NOT NULL DEFAULT 'free',
      status         TEXT NOT NULL DEFAULT 'unknown',
      payment_due_at TEXT NOT NULL DEFAULT '',
      payment_hour   TEXT NOT NULL DEFAULT '',
      payment_amount TEXT NOT NULL DEFAULT '',
      enabled        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plan_catalog (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      tagline       TEXT NOT NULL DEFAULT '',
      price         TEXT NOT NULL DEFAULT '',
      price_note    TEXT NOT NULL DEFAULT '',
      color         TEXT NOT NULL DEFAULT '#7F89A8',
      features_json TEXT NOT NULL DEFAULT '[]',
      max_profiles  INTEGER NOT NULL DEFAULT 1,
      max_servers   INTEGER NOT NULL DEFAULT 1,
      highlighted   INTEGER NOT NULL DEFAULT 0,
      enabled       INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_plan_catalog_sort
      ON plan_catalog (enabled DESC, sort_order ASC, id ASC);

    CREATE TABLE IF NOT EXISTS subscription_page_config (
      id                  TEXT PRIMARY KEY,
      triggers_json       TEXT NOT NULL DEFAULT '[]',
      feature_labels_json TEXT NOT NULL DEFAULT '{}',
      compare_order_json  TEXT NOT NULL DEFAULT '[]',
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sync_prefs (
      user_id           TEXT PRIMARY KEY,
      consent_enabled   INTEGER NOT NULL DEFAULT 0,
      auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
      last_sync_at      TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_backups (
      user_id    TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT '',
      data       TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_profile_backups (
      user_id    TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      data       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, profile_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_profile_backups_user_id
      ON user_profile_backups (user_id);

    CREATE TABLE IF NOT EXISTS user_push_tokens (
      expo_push_token TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      last_sent_at    TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id
      ON user_push_tokens (user_id);
  `);
}

// ---- DB helpers -------------------------------------------------------------
function dbGetUserById(userId) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function dbGetUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function dbGetPlan(userId) {
  return getDb().prepare('SELECT * FROM user_plans WHERE user_id = ?').get(userId);
}

function dbListPlanCatalog(includeDisabled = false) {
  const sql = includeDisabled
    ? 'SELECT * FROM plan_catalog ORDER BY sort_order ASC, id ASC'
    : 'SELECT * FROM plan_catalog WHERE enabled = 1 ORDER BY sort_order ASC, id ASC';
  return getDb().prepare(sql).all();
}

function dbGetPlanCatalogById(planId) {
  return getDb().prepare('SELECT * FROM plan_catalog WHERE id = ?').get(planId);
}

function dbUpsertPlanCatalog(plan) {
  getDb().prepare(`
    INSERT INTO plan_catalog (
      id, name, tagline, price, price_note, color, features_json,
      max_profiles, max_servers, highlighted, enabled, sort_order, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      tagline = excluded.tagline,
      price = excluded.price,
      price_note = excluded.price_note,
      color = excluded.color,
      features_json = excluded.features_json,
      max_profiles = excluded.max_profiles,
      max_servers = excluded.max_servers,
      highlighted = excluded.highlighted,
      enabled = excluded.enabled,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `).run(
    plan.id,
    plan.name,
    plan.tagline,
    plan.price,
    plan.priceNote,
    plan.color,
    JSON.stringify(Array.isArray(plan.features) ? plan.features : []),
    plan.maxProfiles,
    plan.maxServers,
    plan.highlighted ? 1 : 0,
    plan.enabled ? 1 : 0,
    plan.sortOrder,
    plan.updatedAt
  );
}

function dbGetSubscriptionPageConfig() {
  return getDb().prepare('SELECT * FROM subscription_page_config WHERE id = ?').get('default');
}

function dbUpsertSubscriptionPageConfig(content) {
  getDb().prepare(`
    INSERT INTO subscription_page_config (id, triggers_json, feature_labels_json, compare_order_json, updated_at)
    VALUES ('default', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      triggers_json = excluded.triggers_json,
      feature_labels_json = excluded.feature_labels_json,
      compare_order_json = excluded.compare_order_json,
      updated_at = excluded.updated_at
  `).run(
    JSON.stringify(Array.isArray(content.triggers) ? content.triggers : []),
    JSON.stringify(content.featureLabels && typeof content.featureLabels === 'object' ? content.featureLabels : {}),
    JSON.stringify(Array.isArray(content.compareOrder) ? content.compareOrder : []),
    content.updatedAt || nowIso()
  );
}

function normalizeSubscriptionPageContent(raw) {
  const safeRaw = raw && typeof raw === 'object' ? raw : {};

  const triggers = Array.isArray(safeRaw.triggers)
    ? safeRaw.triggers
        .map((item) => ({
          icon: String(item?.icon || '').trim() || 'bolt',
          text: String(item?.text || '').trim(),
        }))
        .filter((item) => item.text)
    : [];

  const sourceFeatureLabels = safeRaw.featureLabels && typeof safeRaw.featureLabels === 'object'
    ? safeRaw.featureLabels
    : {};

  const featureLabels = Object.fromEntries(
    Object.entries(sourceFeatureLabels).map(([featureId, meta]) => {
      const safeMeta = meta && typeof meta === 'object' ? meta : {};
      return [
        String(featureId || '').trim(),
        {
          label: String(safeMeta.label || featureId || '').trim(),
          icon: String(safeMeta.icon || 'stars').trim() || 'stars',
          desc: String(safeMeta.desc || '').trim(),
        },
      ];
    }).filter(([featureId]) => !!featureId)
  );

  const compareOrder = Array.isArray(safeRaw.compareOrder)
    ? Array.from(new Set(safeRaw.compareOrder.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];

  const mergedFeatureLabels = {
    ...DEFAULT_SUBSCRIPTION_PAGE_CONTENT.featureLabels,
    ...featureLabels,
  };

  const mergedCompareOrder = compareOrder.length
    ? compareOrder
    : [...DEFAULT_SUBSCRIPTION_PAGE_CONTENT.compareOrder];

  return {
    triggers: triggers.length ? triggers : [...DEFAULT_SUBSCRIPTION_PAGE_CONTENT.triggers],
    featureLabels: mergedFeatureLabels,
    compareOrder: mergedCompareOrder,
  };
}

function subscriptionPageConfigRowToObject(row) {
  if (!row) return null;

  let triggers = [];
  let featureLabels = {};
  let compareOrder = [];

  try {
    triggers = JSON.parse(String(row.triggers_json || '[]'));
  } catch {
    triggers = [];
  }

  try {
    featureLabels = JSON.parse(String(row.feature_labels_json || '{}'));
  } catch {
    featureLabels = {};
  }

  try {
    compareOrder = JSON.parse(String(row.compare_order_json || '[]'));
  } catch {
    compareOrder = [];
  }

  const normalized = normalizeSubscriptionPageContent({
    triggers,
    featureLabels,
    compareOrder,
  });

  return {
    ...normalized,
    updatedAt: String(row.updated_at || nowIso()),
  };
}

function enforcePlanFeatureRules(planId, features) {
  const safePlanId = String(planId || '').trim().toLowerCase();
  const list = Array.isArray(features) ? Array.from(new Set(features)) : [];
  if (safePlanId === 'ultra' || safePlanId === 'lifetime') {
    if (!list.includes('network_proxy')) {
      list.push('network_proxy');
    }
    return list;
  }
  return list.filter((feature) => feature !== 'network_proxy');
}

function planCatalogRowToObject(row) {
  if (!row) return null;
  let features = [];
  try {
    const parsed = JSON.parse(String(row.features_json || '[]'));
    features = Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter((item) => PLAN_FEATURE_IDS.includes(item))
      : [];
  } catch {
    features = [];
  }
  features = enforcePlanFeatureRules(String(row.id || ''), features);

  return {
    id: String(row.id || ''),
    name: String(row.name || row.id || ''),
    tagline: String(row.tagline || ''),
    price: String(row.price || ''),
    priceNote: String(row.price_note || ''),
    color: String(row.color || '#7F89A8'),
    features,
    maxProfiles: Number.isFinite(Number(row.max_profiles)) ? Number(row.max_profiles) : 1,
    maxServers: Number.isFinite(Number(row.max_servers)) ? Number(row.max_servers) : 1,
    highlighted: row.highlighted !== 0,
    enabled: row.enabled !== 0,
    sortOrder: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    updatedAt: String(row.updated_at || nowIso()),
  };
}

function listPlanCatalog(includeDisabled = false) {
  return dbListPlanCatalog(includeDisabled)
    .map(planCatalogRowToObject)
    .filter(Boolean);
}

function ensurePlanCatalogSeed() {
  const now = nowIso();
  const tx = getDb().transaction(() => {
    for (const plan of DEFAULT_PLAN_CATALOG) {
      const existing = planCatalogRowToObject(dbGetPlanCatalogById(plan.id));
      if (existing) {
        // Garante que planos existentes recebam features novas adicionadas ao catálogo padrão
        const existingFeatures = new Set(existing.features || []);
        const defaultFeatures = new Set(plan.features || []);
        const missingFeatures = [...defaultFeatures].filter((f) => !existingFeatures.has(f));
        if (missingFeatures.length > 0) {
          const merged = Array.from(new Set([...(existing.features || []), ...missingFeatures]));
          dbUpsertPlanCatalog({ ...existing, features: merged, updatedAt: now });
        }
        continue;
      }

      dbUpsertPlanCatalog({
        ...plan,
        updatedAt: now,
      });
    }
  });
  tx();
}

function ensureSubscriptionPageConfigSeed() {
  const existing = subscriptionPageConfigRowToObject(dbGetSubscriptionPageConfig());
  if (existing) {
    return;
  }

  dbUpsertSubscriptionPageConfig({
    ...DEFAULT_SUBSCRIPTION_PAGE_CONTENT,
    updatedAt: nowIso(),
  });
}

function getPlanNameById(planId) {
  const fromCatalog = planCatalogRowToObject(dbGetPlanCatalogById(planId));
  if (fromCatalog?.name) {
    return fromCatalog.name;
  }
  return PLAN_LABELS[planId] || planId;
}

function dbGetSyncPrefs(userId) {
  return getDb().prepare('SELECT * FROM user_sync_prefs WHERE user_id = ?').get(userId);
}

function dbGetBackup(userId) {
  return getDb().prepare('SELECT * FROM user_backups WHERE user_id = ?').get(userId);
}

function dbGetProfileBackup(userId, profileId) {
  return getDb().prepare('SELECT * FROM user_profile_backups WHERE user_id = ? AND profile_id = ?').get(userId, profileId);
}

function dbListProfileBackups(userId) {
  return getDb()
    .prepare('SELECT * FROM user_profile_backups WHERE user_id = ? ORDER BY created_at DESC, profile_id ASC')
    .all(userId);
}

function dbGetLatestProfileBackup(userId) {
  return getDb()
    .prepare('SELECT * FROM user_profile_backups WHERE user_id = ? ORDER BY created_at DESC, profile_id ASC LIMIT 1')
    .get(userId);
}

function dbListPushTokens(userId) {
  return getDb().prepare('SELECT * FROM user_push_tokens WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

function dbUpsertPushToken(userId, expoPushToken) {
  const now = nowIso();
  getDb().prepare(`
    INSERT INTO user_push_tokens (expo_push_token, user_id, created_at, updated_at, last_sent_at)
    VALUES (?, ?, ?, ?, '')
    ON CONFLICT(expo_push_token) DO UPDATE SET
      user_id = excluded.user_id,
      updated_at = excluded.updated_at
  `).run(expoPushToken, userId, now, now);
}

function dbMarkPushTokenSent(expoPushToken) {
  getDb().prepare('UPDATE user_push_tokens SET last_sent_at = ?, updated_at = ? WHERE expo_push_token = ?')
    .run(nowIso(), nowIso(), expoPushToken);
}

function dbInsertUser(user) {
  getDb().prepare(`
    INSERT INTO users (id, name, email, avatar_uri, password_hash, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, user.name, user.email, user.avatarUri, user.passwordHash, user.createdAt, user.updatedAt, user.lastLoginAt);
}

function dbInsertDefaultPlan(userId) {
  getDb().prepare(`
    INSERT INTO user_plans (user_id, plan_id, status, payment_due_at, payment_hour, payment_amount, enabled, updated_at)
    VALUES (?, 'free', 'unknown', '', '', '', 1, ?)
  `).run(userId, nowIso());
}

function dbInsertDefaultSyncPrefs(userId) {
  getDb().prepare(`
    INSERT INTO user_sync_prefs (user_id, consent_enabled, auto_sync_enabled, last_sync_at)
    VALUES (?, 0, 0, '')
  `).run(userId);
}

function dbInsertEmptyBackup(userId) {
  getDb().prepare(`
    INSERT INTO user_backups (user_id, created_at, data) VALUES (?, '', '')
  `).run(userId);
}

function dbUpsertPlan(userId, plan) {
  getDb().prepare(`
    INSERT INTO user_plans (user_id, plan_id, status, payment_due_at, payment_hour, payment_amount, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      status = excluded.status,
      payment_due_at = excluded.payment_due_at,
      payment_hour = excluded.payment_hour,
      payment_amount = excluded.payment_amount,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(userId, plan.planId, plan.status, plan.paymentDueAt, plan.paymentHour, plan.paymentAmount, plan.enabled ? 1 : 0, plan.updatedAt);
}

function dbUpsertSyncPrefs(userId, prefs) {
  getDb().prepare(`
    INSERT INTO user_sync_prefs (user_id, consent_enabled, auto_sync_enabled, last_sync_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      consent_enabled = excluded.consent_enabled,
      auto_sync_enabled = excluded.auto_sync_enabled,
      last_sync_at = excluded.last_sync_at
  `).run(userId, prefs.consentEnabled ? 1 : 0, prefs.autoSyncEnabled ? 1 : 0, prefs.lastSyncAt || '');
}

function dbUpsertBackup(userId, createdAt, data) {
  getDb().prepare(`
    INSERT INTO user_backups (user_id, created_at, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      created_at = excluded.created_at,
      data = excluded.data
  `).run(userId, createdAt, typeof data === 'string' ? data : JSON.stringify(data));
}

function dbUpsertProfileBackup(userId, profileId, createdAt, data) {
  getDb().prepare(`
    INSERT INTO user_profile_backups (user_id, profile_id, created_at, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, profile_id) DO UPDATE SET
      created_at = excluded.created_at,
      data = excluded.data
  `).run(userId, profileId, createdAt, typeof data === 'string' ? data : JSON.stringify(data));
}

function planRowToObject(row) {
  if (!row) {
    return { planId: 'free', status: 'unknown', paymentDueAt: '', paymentHour: '', paymentAmount: '', enabled: true, updatedAt: nowIso() };
  }
  return {
    planId: row.plan_id,
    status: row.status,
    paymentDueAt: row.payment_due_at,
    paymentHour: row.payment_hour,
    paymentAmount: row.payment_amount,
    enabled: row.enabled !== 0,
    updatedAt: row.updated_at,
  };
}

function syncPrefsRowToObject(row) {
  if (!row) {
    return { consentEnabled: false, autoSyncEnabled: false, lastSyncAt: '' };
  }
  return {
    consentEnabled: row.consent_enabled !== 0,
    autoSyncEnabled: row.auto_sync_enabled !== 0,
    lastSyncAt: row.last_sync_at || '',
  };
}

function toPublicUser(row) {
  const plan = planRowToObject(dbGetPlan(row.id));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUri: row.avatar_uri || '',
    active: plan.enabled !== false,
    provider: 'email',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || row.created_at,
  };
}

function buildUserToken(user) {
  return jwt.sign(
    { kind: 'user', userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function buildAdminToken() {
  return jwt.sign(
    { kind: 'admin', scope: 'all' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function isExpoPushToken(value) {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(String(value || '').trim());
}

async function sendExpoPushMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return;
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.errors?.[0]?.message === 'string' ? body.errors[0].message : `Push HTTP ${response.status}`);
  }

  return body;
}

async function notifyPlanChange(user, planState, options = {}) {
  const tokens = dbListPushTokens(user.id)
    .map((row) => String(row.expo_push_token || '').trim())
    .filter(isExpoPushToken);

  if (!tokens.length) {
    logAuth('PLAN_PUSH_SKIPPED', { userId: user.id, reason: 'NO_TOKENS' });
    return;
  }

  const safePlanId = normalizePlanId(planState?.planId);
  const safeStatus = normalizePlanStatus(planState?.status);
  const enabled = planState?.enabled !== false;
  const planName = getPlanNameById(safePlanId);
  const previousPlanId = normalizePlanId(options.previousPlanId);

  const downgradedToFree = safePlanId === 'free' || !enabled || safeStatus === 'expired';
  const title = downgradedToFree ? 'Plano atualizado' : 'Plano ativado';
  const body = downgradedToFree
    ? `Seu acesso agora esta no plano ${planName}. Abra o app para revisar os recursos ativos.`
    : previousPlanId !== safePlanId
      ? `Parabens! Seu plano ${planName} ja esta ativo no app e os novos recursos foram liberados.`
      : `Parabens! Seu plano ${planName} foi confirmado como ativo no app.`;

  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    channelId: 'plan-updates',
    priority: 'high',
    data: {
      type: 'plan_changed',
      planState: {
        planId: safePlanId,
        status: safeStatus,
        paymentDueAt: String(planState?.paymentDueAt || ''),
        paymentHour: String(planState?.paymentHour || ''),
        paymentAmount: String(planState?.paymentAmount || ''),
        enabled,
        updatedAt: String(planState?.updatedAt || nowIso()),
        checkedAt: nowIso(),
      },
    },
  }));

  const pushResult = await sendExpoPushMessages(messages);
  tokens.forEach((token) => dbMarkPushTokenSent(token));
  logAuth('PLAN_PUSH_SENT', {
    userId: user.id,
    planId: safePlanId,
    totalTokens: tokens.length,
    expoData: Array.isArray(pushResult?.data) ? pushResult.data : pushResult,
  });
}

function accountKey(username, serverUrl) {
  return `${username}@${String(serverUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

function splitAccountKey(value) {
  const raw = String(value || '');
  const sep = raw.indexOf('@');
  if (sep <= 0) {
    return { username: '', host: '' };
  }
  return {
    username: raw.slice(0, sep).trim(),
    host: raw.slice(sep + 1).trim(),
  };
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function countCollection(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function decodeBackupEntries(data) {
  const rawMap = data && typeof data === 'object' ? data : {};
  const decoded = {};
  for (const [key, value] of Object.entries(rawMap)) {
    if (typeof value !== 'string') {
      decoded[key] = value;
      continue;
    }
    decoded[key] = safeJsonParse(value, value);
  }
  return decoded;
}

function summarizeBackupDecoded(decoded) {
  const settings = decoded['accountSettings.v1'] && typeof decoded['accountSettings.v1'] === 'object'
    ? decoded['accountSettings.v1']
    : null;
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
  const servers = Array.isArray(settings?.servers) ? settings.servers : [];
  const listsV2 = decoded['user_lists_v2'];
  const movieProgress = decoded.movieProgressMap;
  const seriesProgress = decoded.seriesProgressMap;
  const downloads = decoded.downloaded_library_v1;
  const behaviorEvents = decoded['taste.watchSignals.v1'];
  const onboarding = decoded['behavior.onboarding.state.v1'];
  const bootstrap = decoded['behavior.bootstrap.preferences.v1'];

  return {
    keyCount: Object.keys(decoded).length,
    serverCount: servers.length,
    profileCount: profiles.length,
    primaryProfiles: profiles.filter((item) => item?.isPrimary === true).length,
    kidsProfiles: profiles.filter((item) => item?.kidsMode === true).length,
    activeServerId: String(settings?.activeServerId || ''),
    activeProfileId: String(settings?.activeProfileId || ''),
    userListsCount: countCollection(listsV2?.lists || listsV2),
    movieProgressCount: countCollection(movieProgress),
    seriesProgressCount: countCollection(seriesProgress),
    downloadedCount: countCollection(downloads?.items || downloads),
    behaviorSignalCount: countCollection(behaviorEvents),
    algorithm: {
      onboardingPending: decoded['behavior.onboarding.pending.v1'] === true,
      onboardingDone: onboarding?.done === true,
      onboardingSkipped: onboarding?.skipped === true,
      hasBootstrap: !!bootstrap,
      favoriteGenreCount: countCollection(bootstrap?.favoriteGenres),
      favoriteCategoryCount: countCollection(bootstrap?.favoriteCategories),
    },
  };
}

function buildRealtimeAdminState(settings) {
  const now = nowMs();
  const servers = Array.isArray(settings?.servers) ? settings.servers : [];
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];

  const knownProfileIds = new Set(
    profiles
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean)
  );
  const knownUsernames = new Set(
    servers
      .map((item) => String(item?.username || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const serverMap = new Map();
  for (const server of servers) {
    const username = String(server?.username || '').trim();
    const url = String(server?.url || '').trim();
    const key = username && url ? accountKey(username, url) : '';
    if (!key) continue;
    serverMap.set(key, { ...server, username, url, accountKey: key });
  }

  for (const key of Object.keys(sessions)) {
    const parsed = splitAccountKey(key);
    const hasKnownUsername = parsed.username && knownUsernames.has(parsed.username.toLowerCase());
    const hasKnownProfile = Object.keys(sessions[key] || {}).some((profileId) => knownProfileIds.has(String(profileId || '').trim()));
    if (!hasKnownUsername && !hasKnownProfile) {
      continue;
    }
    if (!serverMap.has(key)) {
      serverMap.set(key, {
        id: `runtime-${key}`,
        name: parsed.username ? `Conta ativa: ${parsed.username}` : 'Conta ativa (runtime)',
        username: parsed.username,
        url: parsed.host ? `https://${parsed.host}` : '',
        runtimeOnly: true,
        accountKey: key,
      });
    }
  }

  return Array.from(serverMap.values()).map((server) => {
    const username = String(server?.username || '').trim();
    const url = String(server?.url || '').trim();
    const key = String(server?.accountKey || (username && url ? accountKey(username, url) : '')).trim();
    const sessionGroup = key ? sessions[key] || {} : {};
    const presence = key ? presenceSnapshot(key) : [];
    const blocked = key ? getBlockedList(key) : [];
    const rules = key ? getParentalRules(key) : DEFAULT_PARENTAL_RULES;
    const activity = key && parentalActivity[key] && typeof parentalActivity[key] === 'object'
      ? Object.entries(parentalActivity[key]).map(([profileId]) => {
          const detailed = getProfileActivity(key, profileId);
          const bucket = parentalActivity[key]?.[profileId] || {};
          const session = sessionGroup[profileId] || null;
          const profileMeta = profiles.find((item) => String(item?.id || '') === String(profileId || '')) || null;
          return {
            profileId,
            profileName: session?.profileName || profileMeta?.name || profileId,
            isPrimary: profileMeta?.isPrimary === true,
            kidsMode: profileMeta?.kidsMode === true || session?.kidsMode === true,
            online: session?.online === true,
            deviceId: session?.deviceId || '',
            socketId: session?.socketId || '',
            connectedAt: session?.connectedAt || 0,
            sessionDurationMin: session?.connectedAt ? Math.max(0, Math.round((now - Number(session.connectedAt || now)) / 60000)) : 0,
            lastSeen: session?.lastSeen || 0,
            watching: session?.watching || null,
            watchingDurationMin:
              session?.watching?.since
                ? Math.max(0, Math.round((now - Number(session.watching.since || now)) / 60000))
                : 0,
            activeWatchStart: bucket?.activeWatchStart || null,
            blockedUntil: bucket?.penaltyState?.blockedUntil || 0,
            searches: detailed.searches,
            watchHistory: detailed.watchHistory,
            minutesByHour: detailed.minutesByHour,
            totalMinutes: detailed.totalMinutes,
          };
        })
      : [];

    const runtimeProfiles = Object.keys(sessionGroup || {}).map((profileId) => ({
      id: String(profileId || ''),
      name: String(sessionGroup?.[profileId]?.profileName || `Perfil ${profileId}`),
      enabled: true,
      isPrimary: false,
      kidsMode: sessionGroup?.[profileId]?.kidsMode === true,
      pinEnabled: false,
      avatarUri: '',
      createdAt: '',
      updatedAt: '',
    }));
    const mergedProfiles = mergeUniqueProfiles(profiles, runtimeProfiles);

    const resolvedProfiles = mergedProfiles.map((profile) => {
      const presenceItem = presence.find((item) => String(item.profileId || '') === String(profile.id || '')) || null;
      const activityItem = activity.find((item) => String(item.profileId || '') === String(profile.id || '')) || null;
      return {
        profileId: String(profile.id || ''),
        profileName: String(profile.name || 'Perfil'),
        enabled: profile.enabled !== false,
        isPrimary: profile.isPrimary === true,
        kidsMode: profile.kidsMode === true,
        pinEnabled: profile.pinEnabled === true,
        avatarUri: String(profile.avatarUri || ''),
        createdAt: String(profile.createdAt || ''),
        updatedAt: String(profile.updatedAt || ''),
        online: presenceItem?.online === true,
        watching: presenceItem?.watching || activityItem?.watching || null,
        connectedAt: presenceItem?.connectedAt || activityItem?.connectedAt || 0,
        sessionDurationMin:
          Number(presenceItem?.connectedAt || activityItem?.connectedAt || 0) > 0
            ? Math.max(0, Math.round((now - Number(presenceItem?.connectedAt || activityItem?.connectedAt || now)) / 60000))
            : 0,
        watchingDurationMin:
          Number((presenceItem?.watching || activityItem?.watching || null)?.since || 0) > 0
            ? Math.max(0, Math.round((now - Number((presenceItem?.watching || activityItem?.watching).since || now)) / 60000))
            : 0,
        lastSeen: presenceItem?.lastSeen || activityItem?.lastSeen || 0,
        totalMinutes: activityItem?.totalMinutes || 0,
        searchesCount: Array.isArray(activityItem?.searches) ? activityItem.searches.length : 0,
        watchHistoryCount: Array.isArray(activityItem?.watchHistory) ? activityItem.watchHistory.length : 0,
      };
    });

    return {
      serverId: String(server?.id || ''),
      serverName: String(server?.name || ''),
      username,
      url,
      accountKey: key,
      presence,
      blockedCount: blocked.length,
      blocked,
      parentalRules: rules,
      activity,
      resolvedProfiles,
    };
  });
}

function mergeUniqueProfiles(baseProfiles, extraProfiles) {
  const map = new Map();
  for (const profile of [...(baseProfiles || []), ...(extraProfiles || [])]) {
    const id = String(profile?.id || '').trim();
    if (!id) continue;
    const prev = map.get(id) || {};
    map.set(id, { ...prev, ...profile, id });
  }
  return [...map.values()];
}

function mergeUniqueServers(baseServers, extraServers) {
  const map = new Map();
  for (const server of [...(baseServers || []), ...(extraServers || [])]) {
    const username = String(server?.username || '').trim();
    const url = String(server?.url || '').trim();
    if (!username || !url) continue;
    const key = `${username}@@${url.replace(/\/$/, '')}`;
    const prev = map.get(key) || {};
    map.set(key, { ...prev, ...server, username, url: url.replace(/\/$/, '') });
  }
  return [...map.values()];
}

function mergeAccountSettings(baseSettings, extraSettings) {
  const base = baseSettings && typeof baseSettings === 'object' ? baseSettings : {};
  const extra = extraSettings && typeof extraSettings === 'object' ? extraSettings : {};
  const mergedProfiles = mergeUniqueProfiles(base.profiles, extra.profiles);
  const mergedServers = mergeUniqueServers(base.servers, extra.servers);
  const activeServerId = String(base.activeServerId || extra.activeServerId || '').trim();
  const activeProfileId = String(base.activeProfileId || extra.activeProfileId || '').trim();
  return {
    ...extra,
    ...base,
    servers: mergedServers,
    profiles: mergedProfiles,
    activeServerId,
    activeProfileId,
  };
}

function extractAccountSettingsFromPayload(payload) {
  const settings = payload?.decodedEntries?.['accountSettings.v1'];
  return settings && typeof settings === 'object' ? settings : null;
}

function resolveAdminRealtimeContextForUser(userId) {
  const backupRow = dbGetBackup(userId);
  const backupPayload = buildBackupAdminPayload(backupRow);
  const profileBackupRows = dbListProfileBackups(userId);
  const profilePayloads = profileBackupRows.map((row) => ({
    profileId: row.profile_id,
    ...buildBackupAdminPayload(row),
  }));

  let source = 'none';
  let mergedSettings = null;

  const globalSettings = extractAccountSettingsFromPayload(backupPayload);
  if (globalSettings) {
    mergedSettings = mergeAccountSettings(mergedSettings, globalSettings);
    source = 'global-backup';
  }

  for (const profilePayload of profilePayloads) {
    const profileSettings = extractAccountSettingsFromPayload(profilePayload);
    if (!profileSettings) continue;
    mergedSettings = mergeAccountSettings(mergedSettings, profileSettings);
    if (source === 'none') source = 'profile-backups';
    if (source === 'global-backup') source = 'global+profile';
  }

  const realtime = buildRealtimeAdminState(mergedSettings);

  return {
    source,
    settings: mergedSettings,
    realtime,
    backupPayload,
    profilePayloads,
  };
}

function getAdminAccountContextForUser(userId, accountKeyValue) {
  const resolved = resolveAdminRealtimeContextForUser(userId);
  const accounts = resolved.realtime;
  const account = accounts.find((item) => String(item.accountKey || '') === String(accountKeyValue || ''));
  if (!account) {
    throw new Error('Conta realtime nao encontrada para este usuario.');
  }

  return {
    payload: resolved.backupPayload,
    settings: resolved.settings,
    account,
    source: resolved.source,
  };
}

function disconnectProfileSessionForAdmin(accountKeyValue, profileId) {
  const group = sessions[accountKeyValue];
  const sess = group?.[profileId];
  if (!sess) {
    return false;
  }

  finalizeWatchSession(accountKeyValue, profileId, sess.watching);
  delete group[profileId];
  if (Object.keys(group).length === 0) {
    delete sessions[accountKeyValue];
  }
  io.to(accountKeyValue).emit('presence_update', presenceSnapshot(accountKeyValue));
  return true;
}

function clearProfileActivityForAdmin(accountKeyValue, profileId, options) {
  const bucket = ensureActivityBucket(accountKeyValue, profileId);
  if (options.searches !== false) {
    bucket.searches = [];
  }
  if (options.watchHistory !== false) {
    bucket.watchHistory = [];
    bucket.minutesByHour = {};
    bucket.activeWatchStart = null;
  }
  if (options.penalty !== false) {
    bucket.penaltyState = {
      violationTs: [],
      blockedUntil: 0,
    };
    bucket.ruleCooldownTs = {};
  }
  return getProfileActivity(accountKeyValue, profileId);
}

function buildBackupAdminPayload(row) {
  if (!row || !row.data) {
    return null;
  }

  const rawMap = safeJsonParse(row.data, null);
  if (!rawMap || typeof rawMap !== 'object') {
    return {
      createdAt: row.created_at || '',
      parseError: 'Backup corrompido.',
      rawSizeBytes: Buffer.byteLength(String(row.data || ''), 'utf8'),
      keys: [],
      rawEntries: {},
      decodedEntries: {},
      summary: null,
      realtime: [],
    };
  }

  const decodedEntries = decodeBackupEntries(rawMap);
  const accountSettings = decodedEntries['accountSettings.v1'] && typeof decodedEntries['accountSettings.v1'] === 'object'
    ? decodedEntries['accountSettings.v1']
    : null;

  return {
    createdAt: row.created_at || '',
    parseError: '',
    rawSizeBytes: Buffer.byteLength(String(row.data || ''), 'utf8'),
    keys: Object.keys(rawMap),
    rawEntries: rawMap,
    decodedEntries,
    summary: summarizeBackupDecoded(decodedEntries),
    realtime: buildRealtimeAdminState(accountSettings),
  };
}

function getAdminOverview() {
  const db = getDb();
  const usersCount = db.prepare('SELECT COUNT(*) as total FROM users').get().total;
  const backupsCount = db.prepare("SELECT COUNT(*) as total FROM user_backups WHERE data IS NOT NULL AND data != ''").get().total;
  const profileBackupsCount = db.prepare("SELECT COUNT(*) as total FROM user_profile_backups WHERE data IS NOT NULL AND data != ''").get().total;
  const pushTokensCount = db.prepare('SELECT COUNT(*) as total FROM user_push_tokens').get().total;
  const activePlansCount = db.prepare('SELECT COUNT(*) as total FROM user_plans WHERE enabled = 1').get().total;
  const totalProfileSessions = Object.values(sessions).reduce((sum, group) => sum + Object.keys(group || {}).length, 0);
  const onlineProfileSessions = Object.values(sessions).reduce(
    (sum, group) => sum + Object.values(group || {}).filter((entry) => entry?.online === true).length,
    0
  );

  return {
    usersCount,
    backupsCount,
    profileBackupsCount,
    pushTokensCount,
    activePlansCount,
    totalProfileSessions,
    onlineProfileSessions,
    generatedAt: nowIso(),
  };
}

function parseCurrencyToNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDateToMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function buildAdminFinancialMetrics() {
  const users = getDb().prepare('SELECT id, name, email, created_at, last_login_at FROM users ORDER BY created_at DESC').all();
  const now = nowMs();
  const next30Days = now + (30 * 24 * 60 * 60 * 1000);
  const plansDistribution = {};
  for (const id of PLAN_IDS) {
    plansDistribution[id] = 0;
  }

  let activeUsersCount = 0;
  let activeRevenue = 0;
  let forecastRevenue30d = 0;
  const dueSoon = [];

  for (const user of users) {
    const plan = planRowToObject(dbGetPlan(user.id));
    const planId = normalizePlanId(plan.planId);
    plansDistribution[planId] = Number(plansDistribution[planId] || 0) + 1;

    const status = normalizePlanStatus(plan.status);
    const enabled = plan.enabled !== false;
    const amount = parseCurrencyToNumber(plan.paymentAmount);
    const dueAtMs = parseDateToMs(plan.paymentDueAt);

    if (enabled && (status === 'active' || status === 'grace')) {
      activeUsersCount += 1;
      activeRevenue += amount;
    }

    if (enabled && amount > 0 && dueAtMs >= now && dueAtMs <= next30Days) {
      forecastRevenue30d += amount;
      dueSoon.push({
        userId: user.id,
        userName: user.name || user.email || user.id,
        planId,
        amount,
        paymentDueAt: plan.paymentDueAt || '',
      });
    }
  }

  dueSoon.sort((a, b) => parseDateToMs(a.paymentDueAt) - parseDateToMs(b.paymentDueAt));

  return {
    usersCount: users.length,
    activeUsersCount,
    activeRevenue: Math.round(activeRevenue * 100) / 100,
    forecastRevenue30d: Math.round(forecastRevenue30d * 100) / 100,
    plansDistribution,
    dueSoon: dueSoon.slice(0, 40),
  };
}

function buildAdminServerMetrics() {
  const health = buildHealthPayload();
  const users = getDb().prepare('SELECT id, name, email FROM users ORDER BY created_at DESC').all();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();

  const userMetrics = users.map((user) => {
    const resolved = resolveAdminRealtimeContextForUser(user.id);
    const realtime = Array.isArray(resolved?.realtime) ? resolved.realtime : [];
    const totalProfiles = realtime.reduce((sum, account) => sum + (Array.isArray(account?.resolvedProfiles) ? account.resolvedProfiles.length : 0), 0);
    const onlineProfiles = realtime.reduce(
      (sum, account) => sum + (Array.isArray(account?.resolvedProfiles) ? account.resolvedProfiles.filter((item) => item?.online).length : 0),
      0
    );
    const searchesCount = realtime.reduce(
      (sum, account) => sum + (Array.isArray(account?.activity) ? account.activity.reduce((acc, item) => acc + (Array.isArray(item?.searches) ? item.searches.length : 0), 0) : 0),
      0
    );
    const watchHistoryCount = realtime.reduce(
      (sum, account) => sum + (Array.isArray(account?.activity) ? account.activity.reduce((acc, item) => acc + (Array.isArray(item?.watchHistory) ? item.watchHistory.length : 0), 0) : 0),
      0
    );
    const watchingNowCount = realtime.reduce(
      (sum, account) => sum + (Array.isArray(account?.resolvedProfiles) ? account.resolvedProfiles.filter((item) => !!item?.watching).length : 0),
      0
    );

    const backupMb = Number(resolved?.backupPayload?.rawSizeBytes || 0) / (1024 * 1024);
    const cpuEstimate = Math.min(100, Math.round((onlineProfiles * 13 + watchingNowCount * 9 + searchesCount * 0.65 + watchHistoryCount * 0.2) * 10) / 10);
    const memoryEstimateMb = Math.round((50 + totalProfiles * 14 + onlineProfiles * 34 + backupMb * 4) * 10) / 10;
    const loadScore = Math.min(100, Math.round(cpuEstimate * 0.6 + (memoryEstimateMb / 6) * 0.4));

    return {
      userId: user.id,
      userName: user.name || user.email || user.id,
      userEmail: user.email || '',
      totalProfiles,
      onlineProfiles,
      watchingNowCount,
      searchesCount,
      watchHistoryCount,
      cpuEstimatePercent: cpuEstimate,
      memoryEstimateMb,
      loadScore,
    };
  }).sort((a, b) => b.loadScore - a.loadScore);

  const estimatedCpuPercent = Math.min(
    100,
    Math.round(
      (userMetrics.reduce((sum, item) => sum + Number(item.cpuEstimatePercent || 0), 0) / Math.max(1, userMetrics.length))
    )
  );
  const estimatedMemoryMb = Math.round(userMetrics.reduce((sum, item) => sum + Number(item.memoryEstimateMb || 0), 0));

  return {
    generatedAt: nowIso(),
    health,
    server: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSec: Math.round(process.uptime()),
      loadAvg1m: Math.round((os.loadavg()[0] || 0) * 100) / 100,
      cpuUserMs: Math.round((cpu.user || 0) / 1000),
      cpuSystemMs: Math.round((cpu.system || 0) / 1000),
      eventLoopLagMs,
      memoryMb: {
        rss: Math.round((memory.rss / (1024 * 1024)) * 10) / 10,
        heapUsed: Math.round((memory.heapUsed / (1024 * 1024)) * 10) / 10,
        heapTotal: Math.round((memory.heapTotal / (1024 * 1024)) * 10) / 10,
        external: Math.round((memory.external / (1024 * 1024)) * 10) / 10,
      },
      estimatedCpuPercent,
      estimatedMemoryMb,
    },
    topUsers: userMetrics.slice(0, 60),
  };
}

function buildAdminPlayersMonitor() {
  pruneProxySessions();
  pruneProxyHlsPipelines();

  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const now = nowMs();

  const activePlayers = [];
  for (const [accountKeyValue, group] of Object.entries(sessions || {})) {
    for (const [profileId, sess] of Object.entries(group || {})) {
      if (!sess || sess.online !== true) continue;
      const watching = sess.watching || null;
      if (!watching) continue;

      const contentType = String(watching.contentType || 'movie');
      const startedAt = Number(watching.since || 0);
      const durationMin = startedAt > 0 ? Math.max(0, Math.round((now - startedAt) / 60000)) : 0;

      activePlayers.push({
        accountKey: String(accountKeyValue || ''),
        profileId: String(profileId || ''),
        profileName: String(sess.profileName || profileId || 'Perfil'),
        kidsMode: sess.kidsMode === true,
        contentId: String(watching.contentId || ''),
        contentTitle: String(watching.contentTitle || 'Conteudo'),
        contentType,
        previewUrl: String(watching.previewUrl || ''),
        posterUrl: String(watching.posterUrl || ''),
        positionMs: Math.max(0, Number(watching.positionMs || 0)),
        durationMs: Math.max(0, Number(watching.durationMs || 0)),
        connectedAt: Number(sess.connectedAt || 0),
        lastSeen: Number(sess.lastSeen || 0),
        watchingSince: startedAt,
        watchingDurationMin: durationMin,
      });
    }
  }

  activePlayers.sort((a, b) => Number(b.watchingSince || 0) - Number(a.watchingSince || 0));

  const proxySessions = Array.from(proxyActiveSessions.entries()).map(([id, s]) => ({
    id,
    userId: String(s.userId || 'anon'),
    profileName: String(s.profileName || 'Perfil'),
    url: String(s.url || ''),
    processingPath: String(s.processingPath || ''),
    contentType: String(s.contentType || ''),
    quality: String(s.quality || 'auto'),
    hlsType: String(s.hlsType || ''),
    lowLatencyLive: s.lowLatencyLive !== false,
    aggressiveReconnect: s.aggressiveReconnect !== false,
    bytesProxied: Math.max(0, Number(s.bytesProxied || 0)),
    startedAt: Number(s.startedAt || 0),
    lastSeenAt: Number(s.lastSeenAt || 0),
  }));

  const bytesTotal = proxySessions.reduce((sum, item) => sum + Number(item.bytesProxied || 0), 0);

  return {
    generatedAt: nowIso(),
    server: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSec: Math.round(process.uptime()),
      eventLoopLagMs,
      cpuUserMs: Math.round((cpu.user || 0) / 1000),
      cpuSystemMs: Math.round((cpu.system || 0) / 1000),
      memoryMb: {
        rss: Math.round((memory.rss / (1024 * 1024)) * 10) / 10,
        heapUsed: Math.round((memory.heapUsed / (1024 * 1024)) * 10) / 10,
        heapTotal: Math.round((memory.heapTotal / (1024 * 1024)) * 10) / 10,
        external: Math.round((memory.external / (1024 * 1024)) * 10) / 10,
      },
    },
    summary: {
      activePlayers: activePlayers.length,
      activeLivePlayers: activePlayers.filter((item) => item.contentType === 'live').length,
      activeSeriesPlayers: activePlayers.filter((item) => item.contentType === 'series').length,
      activeMoviePlayers: activePlayers.filter((item) => item.contentType === 'movie').length,
      proxySessions: proxySessions.length,
      proxiedTrafficMb: Math.round((bytesTotal / (1024 * 1024)) * 100) / 100,
    },
    activePlayers,
    proxySessions,
  };
}

function buildAdminDashboardPayload() {
  return {
    generatedAt: nowIso(),
    overview: getAdminOverview(),
    financial: buildAdminFinancialMetrics(),
    health: buildHealthPayload(),
    planCatalog: listPlanCatalog(true).map((item) => ({
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      highlighted: item.highlighted,
      sortOrder: item.sortOrder,
      price: item.price,
    })),
    recentLogs: adminAuditLogs.slice(0, 30),
  };
}

function loadEditableAccountSettingsFromBackup(row) {
  if (!row || !row.data) {
    throw new Error('Nenhum backup global encontrado para este usuario.');
  }

  const rawMap = safeJsonParse(row.data, null);
  if (!rawMap || typeof rawMap !== 'object') {
    throw new Error('Backup global corrompido.');
  }

  const accountSettingsRaw = rawMap['accountSettings.v1'];
  const accountSettings = typeof accountSettingsRaw === 'string'
    ? safeJsonParse(accountSettingsRaw, null)
    : accountSettingsRaw;

  if (!accountSettings || typeof accountSettings !== 'object') {
    throw new Error('accountSettings.v1 nao encontrado no backup global.');
  }

  return { rawMap, accountSettings };
}

function presenceSnapshot(key) {
  const group = sessions[key] || {};
  return Object.entries(group).map(([profileId, s]) => ({
    profileId,
    profileName: s.profileName,
    kidsMode: s.kidsMode,
    online: s.online,
    watching: s.watching,
    connectedAt: s.connectedAt || 0,
    lastSeen: s.lastSeen,
  }));
}

function getBlockedList(key) {
  return [...(blockedContent[key] || [])];
}

function ensureActivityBucket(key, profileId) {
  if (!parentalActivity[key]) parentalActivity[key] = {};
  if (!parentalActivity[key][profileId]) {
    parentalActivity[key][profileId] = {
      searches: [],
      watchHistory: [],
      minutesByHour: {},
      activeWatchStart: null,
      ruleCooldownTs: {},
      penaltyState: {
        violationTs: [],
        blockedUntil: 0,
      },
    };
  }
  return parentalActivity[key][profileId];
}

function normalizeRules(input) {
  const safe = input && typeof input === 'object' ? input : {};
  const keywords = Array.isArray(safe.forbiddenSearchKeywords)
    ? safe.forbiddenSearchKeywords.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean).slice(0, 40)
    : DEFAULT_PARENTAL_RULES.forbiddenSearchKeywords;

  const maxMinutesPerHour = Number(safe.maxMinutesPerHour);
  const maxContinuousMinutes = Number(safe.maxContinuousMinutes);
  const penaltyWindowMinutes = Number(safe.penaltyWindowMinutes);
  const step2BlockMinutes = Number(safe.step2BlockMinutes);
  const step3BlockMinutes = Number(safe.step3BlockMinutes);

  return {
    aggressiveMode: safe.aggressiveMode === true,
    autoBlockOnForbiddenSearch: safe.autoBlockOnForbiddenSearch !== false,
    criticalAlertsEnabled: safe.criticalAlertsEnabled !== false,
    progressivePenaltyEnabled: safe.progressivePenaltyEnabled === true,
    penaltyWindowMinutes:
      Number.isFinite(penaltyWindowMinutes) && penaltyWindowMinutes > 0
        ? Math.min(1440, Math.max(10, Math.round(penaltyWindowMinutes)))
        : DEFAULT_PARENTAL_RULES.penaltyWindowMinutes,
    step2BlockMinutes:
      Number.isFinite(step2BlockMinutes) && step2BlockMinutes > 0
        ? Math.min(720, Math.max(1, Math.round(step2BlockMinutes)))
        : DEFAULT_PARENTAL_RULES.step2BlockMinutes,
    step3BlockMinutes:
      Number.isFinite(step3BlockMinutes) && step3BlockMinutes > 0
        ? Math.min(1440, Math.max(5, Math.round(step3BlockMinutes)))
        : DEFAULT_PARENTAL_RULES.step3BlockMinutes,
    forbiddenSearchKeywords: keywords.length ? keywords : DEFAULT_PARENTAL_RULES.forbiddenSearchKeywords,
    maxMinutesPerHour:
      Number.isFinite(maxMinutesPerHour) && maxMinutesPerHour > 0
        ? Math.min(360, Math.max(5, Math.round(maxMinutesPerHour)))
        : DEFAULT_PARENTAL_RULES.maxMinutesPerHour,
    maxContinuousMinutes:
      Number.isFinite(maxContinuousMinutes) && maxContinuousMinutes > 0
        ? Math.min(480, Math.max(10, Math.round(maxContinuousMinutes)))
        : DEFAULT_PARENTAL_RULES.maxContinuousMinutes,
  };
}

function getParentalRules(key) {
  if (!parentalRules[key]) {
    parentalRules[key] = { ...DEFAULT_PARENTAL_RULES };
  }
  parentalRules[key] = normalizeRules(parentalRules[key]);
  return parentalRules[key];
}

function saveParentalRules(key, input) {
  const current = getParentalRules(key);
  parentalRules[key] = normalizeRules({ ...current, ...(input || {}) });
  return parentalRules[key];
}

function emitParentalAlert(key, payload) {
  io.to(`parents:${key}`).emit('parental_alert', {
    at: nowIso(),
    ...(payload || {}),
  });
}

function canTriggerRule(bucket, ruleKey, cooldownMs = 120000) {
  const now = nowMs();
  const last = Number(bucket?.ruleCooldownTs?.[ruleKey] || 0);
  if (now - last < cooldownMs) return false;
  bucket.ruleCooldownTs[ruleKey] = now;
  return true;
}

function isProfilePenaltyBlocked(key, profileId) {
  const bucket = ensureActivityBucket(key, profileId);
  const until = Number(bucket?.penaltyState?.blockedUntil || 0);
  if (!until) return false;
  if (until <= nowMs()) {
    bucket.penaltyState.blockedUntil = 0;
    return false;
  }
  return true;
}

function compactPenaltyWindow(bucket, rules) {
  if (!bucket.penaltyState) {
    bucket.penaltyState = { violationTs: [], blockedUntil: 0 };
  }
  const now = nowMs();
  const windowMs = Math.max(60_000, Number(rules.penaltyWindowMinutes || 180) * 60_000);
  bucket.penaltyState.violationTs = (bucket.penaltyState.violationTs || [])
    .map((ts) => Number(ts || 0))
    .filter((ts) => now - ts <= windowMs)
    .slice(-12);
}

function registerProgressiveViolation(key, profileId, reasonType, reasonMessage, canBlock) {
  const rules = getParentalRules(key);
  const bucket = ensureActivityBucket(key, profileId);
  compactPenaltyWindow(bucket, rules);

  const now = nowMs();
  bucket.penaltyState.violationTs.push(now);
  compactPenaltyWindow(bucket, rules);
  const step = Math.min(3, bucket.penaltyState.violationTs.length);

  const sess = sessions[key]?.[profileId];
  if (rules.criticalAlertsEnabled) {
    emitParentalAlert(key, {
      type: reasonType,
      profileId,
      profileName: sess?.profileName || profileId,
      message: `[N${step}] ${reasonMessage}`,
      step,
    });
  }

  if (!canBlock) {
    return { step, blocked: false, blockedUntil: 0 };
  }

  if (step >= 2) {
    const durationMin = step === 2 ? rules.step2BlockMinutes : rules.step3BlockMinutes;
    const blockedUntil = now + durationMin * 60_000;
    bucket.penaltyState.blockedUntil = blockedUntil;

    blockCurrentWatchingForProfile(
      key,
      profileId,
      step === 2 ? 'progressive_step2' : 'progressive_step3',
      `Bloqueio progressivo nivel ${step} por ${durationMin} min`
    );

    return { step, blocked: true, blockedUntil };
  }

  return { step, blocked: false, blockedUntil: 0 };
}

function applyViolation(key, profileId, reasonType, reasonMessage, canBlock = true) {
  const rules = getParentalRules(key);
  if (!rules.aggressiveMode) return;

  if (rules.progressivePenaltyEnabled) {
    registerProgressiveViolation(key, profileId, reasonType, reasonMessage, canBlock);
    return;
  }

  const sess = sessions[key]?.[profileId];
  if (rules.criticalAlertsEnabled) {
    emitParentalAlert(key, {
      type: reasonType,
      profileId,
      profileName: sess?.profileName || profileId,
      message: reasonMessage,
    });
  }

  if (canBlock) {
    blockCurrentWatchingForProfile(key, profileId, reasonType, reasonMessage);
  }
}

function blockCurrentWatchingForProfile(key, profileId, reasonType, reasonMessage) {
  const sess = sessions[key]?.[profileId];
  if (!sess || !sess.watching) return false;

  if (!blockedContent[key]) blockedContent[key] = new Set();
  blockedContent[key].add(sess.watching.contentId);

  if (sess.socketId) {
    io.to(sess.socketId).emit('content_blocked', {
      contentId: sess.watching.contentId,
      contentTitle: sess.watching.contentTitle,
      reasonType,
      reasonMessage,
    });
  }

  io.to(`parents:${key}`).emit('parental_block_applied', {
    contentId: sess.watching.contentId,
    contentTitle: sess.watching.contentTitle,
    targetProfileId: profileId,
    blockedAt: nowIso(),
    reasonType,
    reasonMessage,
  });

  finalizeWatchSession(key, profileId, sess.watching);
  sess.watching = null;
  sess.lastSeen = nowMs();
  io.to(key).emit('presence_update', presenceSnapshot(key));
  return true;
}

function applyAggressiveRulesForProfile(key, profileId) {
  const rules = getParentalRules(key);
  if (!rules.aggressiveMode) return;

  const sess = sessions[key]?.[profileId];
  if (!sess || !sess.kidsMode) return;

  if (isProfilePenaltyBlocked(key, profileId)) {
    if (sess.watching) {
      blockCurrentWatchingForProfile(
        key,
        profileId,
        'profile_penalty_lock',
        'Perfil bloqueado por regra progressiva ativa'
      );
    }
    return;
  }

  if (!sess.watching) return;

  const bucket = ensureActivityBucket(key, profileId);
  const now = nowMs();
  const hour = new Date(now).getHours();
  const activeMinutes = Math.max(1, Math.round((now - Number(sess.watching.since || now)) / 60000));
  const hourMinutes = Number(bucket.minutesByHour[hour] || 0) + activeMinutes;

  if (
    rules.maxContinuousMinutes > 0 &&
    activeMinutes >= rules.maxContinuousMinutes &&
    canTriggerRule(bucket, 'continuous')
  ) {
    applyViolation(
      key,
      profileId,
      'continuous_limit',
      `Tempo continuo excedido (${activeMinutes} min)`,
      true
    );
    return;
  }

  if (
    rules.maxMinutesPerHour > 0 &&
    hourMinutes >= rules.maxMinutesPerHour &&
    canTriggerRule(bucket, 'hourly')
  ) {
    applyViolation(
      key,
      profileId,
      'hourly_limit',
      `Limite por hora excedido (${hourMinutes} min)`,
      true
    );
  }
}

function getProfileActivity(key, profileId) {
  const activity = ensureActivityBucket(key, profileId);
  const minutesByHour = activity.minutesByHour || {};
  const totalMinutes = Object.values(minutesByHour).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    profileId,
    searches: activity.searches.slice(0, 60),
    watchHistory: activity.watchHistory.slice(0, 80),
    minutesByHour,
    totalMinutes,
  };
}

function finalizeWatchSession(key, profileId, fallbackWatching) {
  const bucket = ensureActivityBucket(key, profileId);
  const started = bucket.activeWatchStart || fallbackWatching;
  if (!started || !started.contentId) {
    bucket.activeWatchStart = null;
    return;
  }

  const startTs = Number(started.since || nowMs());
  const endTs = nowMs();
  const durationMin = Math.max(1, Math.round((endTs - startTs) / 60000));
  const startedAtIso = new Date(startTs).toISOString();
  const hour = new Date(startTs).getHours();

  bucket.watchHistory.unshift({
    contentId: String(started.contentId || ''),
    contentTitle: String(started.contentTitle || 'Conteudo'),
    contentType: String(started.contentType || 'movie'),
    startedAt: startedAtIso,
    endedAt: new Date(endTs).toISOString(),
    durationMin,
    hour,
  });
  bucket.watchHistory = bucket.watchHistory.slice(0, 160);

  bucket.minutesByHour[hour] = Number(bucket.minutesByHour[hour] || 0) + durationMin;
  bucket.activeWatchStart = null;
}

function rtAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload || payload.kind) {
      return res.status(401).json({ error: 'Token realtime invalido' });
    }
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function userAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload || payload.kind !== 'user' || !payload.userId) {
      return res.status(401).json({ error: 'Token de usuario invalido' });
    }

    const user = dbGetUserById(payload.userId);
    if (!user) {
      return res.status(401).json({ error: 'Usuario nao encontrado.' });
    }

    const plan = planRowToObject(dbGetPlan(user.id));
    if (plan.enabled === false) {
      return res.status(403).json({ error: 'Usuario inativo. Contate o administrador.' });
    }

    req.userAuth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function adminAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload || payload.kind !== 'admin') {
      return res.status(401).json({ error: 'Token admin invalido' });
    }
    req.adminAuth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function buildHealthPayload() {
  const totalProfiles = Object.values(sessions).reduce((sum, group) => sum + Object.keys(group || {}).length, 0);
  const onlineProfiles = Object.values(sessions).reduce(
    (sum, group) =>
      sum +
      Object.values(group || {}).filter((sess) => !!sess && sess.online === true).length,
    0
  );
  const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  const overloaded = onlineProfiles >= 40 || rssMb >= 700 || eventLoopLagMs >= 220;

  return {
    ok: true,
    ts: nowIso(),
    status: overloaded ? 'overloaded' : 'online',
    metrics: {
      totalProfiles,
      onlineProfiles,
      rssMb,
      eventLoopLagMs,
    },
  };
}

app.get('/health', (_req, res) => {
  return res.json(buildHealthPayload());
});

app.get('/api/health', (_req, res) => {
  return res.json(buildHealthPayload());
});

// ---- Continue-Watch Sync APIs (leve, in-memory) ----------------------------
app.post('/api/continue-watch/push', userAuthMiddleware, (req, res) => {
  const userId = req.userAuth.userId;
  const profileId = String(req.body?.profileId || 'default').trim().slice(0, 80);
  const rawItems = req.body?.items;
  if (!Array.isArray(rawItems)) return res.status(400).json({ error: 'items deve ser array' });

  const items = rawItems
    .filter((item) => item && typeof item === 'object')
    .slice(0, 200)
    .map((item) => ({
      id: String(item.id || '').trim(),
      kind: ['vod', 'series', 'live'].includes(item.kind) ? item.kind : 'vod',
      positionMs: Math.max(0, Number(item.positionMs || 0)),
      durationMs: Math.max(0, Number(item.durationMs || 0)),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
    }))
    .filter((item) => item.id);

  if (!continueWatch[userId]) continueWatch[userId] = {};
  continueWatch[userId][profileId] = { items, updatedAt: nowIso() };
  return res.json({ ok: true, count: items.length });
});

app.get('/api/continue-watch/pull', userAuthMiddleware, (req, res) => {
  const userId = req.userAuth.userId;
  const profileId = String(req.query?.profileId || 'default').trim().slice(0, 80);
  const bucket = continueWatch[userId]?.[profileId];
  return res.json({
    items: Array.isArray(bucket?.items) ? bucket.items : [],
    updatedAt: bucket?.updatedAt || null,
  });
});

app.use('/api/auth', (req, res, next) => {
  const startedAt = nowMs();
  res.on('finish', () => {
    logAuth('REQUEST', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: nowMs() - startedAt,
    });
  });
  next();
});

// ---- Auth/user APIs ---------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = safeEmail(req.body?.email || '');
  const password = String(req.body?.password || '').trim();

  if (!name) return res.status(400).json({ error: 'Informe o nome.' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });

  if (dbGetUserByEmail(email)) {
    logAuth('REGISTER_CONFLICT', { email });
    return res.status(409).json({ error: 'Este e-mail ja esta cadastrado.' });
  }

  const now = nowIso();
  const userId = makeId('user');

  getDb().transaction(() => {
    dbInsertUser({ id: userId, name, email, avatarUri: '', passwordHash: hashPassword(password), createdAt: now, updatedAt: now, lastLoginAt: now });
    dbInsertDefaultPlan(userId);
    dbInsertDefaultSyncPrefs(userId);
    dbInsertEmptyBackup(userId);
  })();

  const user = dbGetUserById(userId);
  logAuth('REGISTER_SUCCESS', { userId, email });
  return res.json({ token: buildUserToken(user), user: toPublicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = safeEmail(req.body?.email || '');
  const password = String(req.body?.password || '').trim();

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });
  if (!password) return res.status(400).json({ error: 'Informe a senha.' });

  const user = dbGetUserByEmail(email);
  if (!user || user.password_hash !== hashPassword(password)) {
    logAuth('LOGIN_INVALID', { email });
    return res.status(401).json({ error: 'Credenciais invalidas.' });
  }

  const plan = planRowToObject(dbGetPlan(user.id));
  if (plan.enabled === false) {
    logAuth('LOGIN_BLOCKED_INACTIVE', { userId: user.id, email: user.email });
    return res.status(403).json({ error: 'Usuario inativo. Contate o administrador.' });
  }

  const now = nowIso();
  getDb().prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);
  logAuth('LOGIN_SUCCESS', { userId: user.id, email: user.email });

  return res.json({ token: buildUserToken(user), user: toPublicUser(user) });
});

app.get('/api/auth/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  return res.json({ user: toPublicUser(user) });
});

app.patch('/api/auth/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const nextName = String(req.body?.name || '').trim();
  const nextEmail = safeEmail(req.body?.email || '');
  const hasAvatarUri = Object.prototype.hasOwnProperty.call(req.body || {}, 'avatarUri');
  const nextAvatarUri = hasAvatarUri ? String(req.body?.avatarUri || '').trim() : String(user.avatar_uri || '');

  if (!nextName) return res.status(400).json({ error: 'Informe o nome.' });
  if (!nextEmail || !nextEmail.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });

  if (nextEmail !== user.email) {
    const emailUsed = dbGetUserByEmail(nextEmail);
    if (emailUsed && emailUsed.id !== user.id) {
      return res.status(409).json({ error: 'Ja existe conta com este e-mail.' });
    }
  }

  const now = nowIso();
  getDb().prepare('UPDATE users SET name = ?, email = ?, avatar_uri = ?, updated_at = ? WHERE id = ?')
    .run(nextName, nextEmail, nextAvatarUri, now, user.id);

  const updated = dbGetUserById(user.id);
  logAuth('PROFILE_UPDATED', { userId: updated.id, email: updated.email, hasAvatarUri: !!nextAvatarUri });
  return res.json({ user: toPublicUser(updated), token: buildUserToken(updated) });
});

app.post('/api/auth/avatar', userAuthMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      logAuth('AVATAR_UPLOAD_FAILED', { userId: req.userAuth?.userId, error: String(err.message || err) });
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Imagem muito grande. Limite de 5MB.' });
      }
      return res.status(400).json({ error: 'Falha no upload da imagem.' });
    }

    const user = dbGetUserById(req.userAuth.userId);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

    const uploaded = req.file;
    if (!uploaded || !uploaded.filename) {
      return res.status(400).json({ error: 'Arquivo de imagem e obrigatorio.' });
    }

    const avatarUri = `${req.protocol}://${req.get('host')}/uploads/avatars/${uploaded.filename}`;
    const updatedAt = nowIso();
    getDb().prepare('UPDATE users SET avatar_uri = ?, updated_at = ? WHERE id = ?').run(avatarUri, updatedAt, user.id);
    logAuth('AVATAR_UPLOADED', { userId: user.id, sizeBytes: uploaded.size, avatarUri });

    return res.json({ ok: true, avatarUri });
  });
});

// Upload de imagem para uso em perfis/conteudos sem alterar avatar da conta do usuario.
app.post('/api/auth/avatar/file', userAuthMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      logAuth('AVATAR_FILE_UPLOAD_FAILED', { userId: req.userAuth?.userId, error: String(err.message || err) });
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Imagem muito grande. Limite de 5MB.' });
      }
      return res.status(400).json({ error: 'Falha no upload da imagem.' });
    }

    const user = dbGetUserById(req.userAuth.userId);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

    const uploaded = req.file;
    if (!uploaded || !uploaded.filename) {
      return res.status(400).json({ error: 'Arquivo de imagem e obrigatorio.' });
    }

    const avatarUri = `${req.protocol}://${req.get('host')}/uploads/avatars/${uploaded.filename}`;
    logAuth('AVATAR_FILE_UPLOADED', { userId: user.id, sizeBytes: uploaded.size, avatarUri });

    return res.json({ ok: true, avatarUri });
  });
});

app.post('/api/auth/logout', userAuthMiddleware, (_req, res) => {
  logAuth('LOGOUT', { userId: _req.userAuth.userId });
  return res.json({ ok: true });
});

app.post('/api/notifications/expo-token', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const token = String(req.body?.token || '').trim();
  if (!isExpoPushToken(token)) {
    return res.status(400).json({ error: 'Expo push token invalido.' });
  }

  dbUpsertPushToken(user.id, token);
  logAuth('PUSH_TOKEN_SAVED', { userId: user.id, tokenPreview: `${token.slice(0, 20)}...` });
  return res.json({ ok: true });
});

// ---- Subscription APIs ------------------------------------------------------
app.get('/api/subscription/plans', (_req, res) => {
  return res.json({
    plans: listPlanCatalog(false).map((plan) => ({
      id: plan.id,
      name: plan.name,
      tagline: plan.tagline,
      price: plan.price,
      priceNote: plan.priceNote,
      color: plan.color,
      features: plan.features,
      maxProfiles: plan.maxProfiles,
      maxServers: plan.maxServers,
      highlighted: plan.highlighted === true,
      enabled: plan.enabled !== false,
    })),
  });
});

app.get('/api/subscription/content', (_req, res) => {
  const content = subscriptionPageConfigRowToObject(dbGetSubscriptionPageConfig())
    || {
      ...DEFAULT_SUBSCRIPTION_PAGE_CONTENT,
      updatedAt: nowIso(),
    };

  return res.json({ content });
});

app.get('/api/subscription/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const raw = planRowToObject(dbGetPlan(user.id));
  const effectivePlanId = raw.enabled === false ? 'free' : normalizePlanId(raw.planId);
  const effectiveStatus = raw.enabled === false ? 'expired' : normalizePlanStatus(raw.status);

  return res.json({
    planState: {
      planId: effectivePlanId,
      status: effectiveStatus,
      paymentDueAt: raw.paymentDueAt || '',
      paymentHour: raw.paymentHour || '',
      paymentAmount: raw.paymentAmount || '',
      enabled: raw.enabled !== false,
      updatedAt: raw.updatedAt || nowIso(),
      checkedAt: nowIso(),
    },
  });
});

app.put('/api/subscription/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const current = planRowToObject(dbGetPlan(user.id));

  const plan = {
    planId: normalizePlanId(req.body?.planId),
    status: normalizePlanStatus(req.body?.status || 'active'),
    paymentDueAt: String(req.body?.paymentDueAt || ''),
    paymentHour: String(req.body?.paymentHour || ''),
    paymentAmount: String(req.body?.paymentAmount || ''),
    enabled: req.body?.enabled !== false,
    updatedAt: nowIso(),
  };
  dbUpsertPlan(user.id, plan);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  if (
    current.planId !== plan.planId ||
    current.status !== plan.status ||
    !!current.enabled !== !!plan.enabled ||
    String(current.paymentDueAt || '') !== String(plan.paymentDueAt || '')
  ) {
    notifyPlanChange(user, plan, { previousPlanId: current.planId }).catch((error) => {
      logAuth('PLAN_PUSH_FAILED', { userId: user.id, error: String(error?.message || error) });
    });
  }

  return res.json({ planState: { ...plan, checkedAt: nowIso() } });
});

// ---- Cloud sync APIs --------------------------------------------------------
app.get('/api/sync/prefs', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  return res.json({ prefs: syncPrefsRowToObject(dbGetSyncPrefs(user.id)) });
});

app.put('/api/sync/prefs', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const current = syncPrefsRowToObject(dbGetSyncPrefs(user.id));
  const next = {
    consentEnabled: req.body?.consentEnabled ?? current.consentEnabled,
    autoSyncEnabled: req.body?.autoSyncEnabled ?? current.autoSyncEnabled,
    lastSyncAt: typeof req.body?.lastSyncAt === 'string' ? req.body.lastSyncAt : current.lastSyncAt,
  };
  dbUpsertSyncPrefs(user.id, next);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  return res.json({ prefs: next });
});

app.post('/api/sync/backup', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const data = req.body?.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Payload de backup invalido.' });
  }

  const createdAt = nowIso();
  dbUpsertBackup(user.id, createdAt, data);
  const current = syncPrefsRowToObject(dbGetSyncPrefs(user.id));
  dbUpsertSyncPrefs(user.id, { ...current, lastSyncAt: createdAt });
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(createdAt, user.id);

  return res.json({ ok: true, createdAt });
});

app.post('/api/sync/backup/profile/:profileId', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params?.profileId || '').trim();
  if (!profileId) {
    return res.status(400).json({ error: 'profileId invalido.' });
  }

  const data = req.body?.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Payload de backup invalido.' });
  }

  const createdAt = nowIso();
  // Mantem o backup global alinhado com o fluxo por perfil para evitar
  // divergencia de accountSettings entre app e painel admin.
  dbUpsertBackup(user.id, createdAt, data);
  dbUpsertProfileBackup(user.id, profileId, createdAt, data);
  const current = syncPrefsRowToObject(dbGetSyncPrefs(user.id));
  dbUpsertSyncPrefs(user.id, { ...current, lastSyncAt: createdAt });
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(createdAt, user.id);

  return res.json({ ok: true, createdAt, profileId });
});

app.get('/api/sync/backup/latest', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const row = dbGetBackup(user.id);
  if (!row || !row.data) {
    return res.status(404).json({ error: 'Nenhum backup encontrado.' });
  }

  let parsedData;
  try { parsedData = JSON.parse(row.data); } catch { return res.status(500).json({ error: 'Backup corrompido.' }); }

  // Mescla accountSettings.v1 de todos os backups de perfil para que o cliente
  // sempre receba a lista COMPLETA de perfis, mesmo que alguns não estejam no
  // backup global mais recente (ex.: perfis criados em outros dispositivos ou
  // removidos por engano do backup principal).
  try {
    const profileRows = dbListProfileBackups(user.id);
    if (profileRows && profileRows.length > 0) {
      let mergedSettings = null;
      // Parseia o accountSettings.v1 do backup global como base
      try {
        const globalRaw = parsedData['accountSettings.v1'];
        mergedSettings = globalRaw
          ? (typeof globalRaw === 'string' ? JSON.parse(globalRaw) : globalRaw)
          : null;
      } catch { /* ignora */ }

      // Aplica merge com cada backup de perfil (ordered DESC por created_at)
      for (const pRow of profileRows) {
        if (!pRow.data) continue;
        try {
          const pData = JSON.parse(pRow.data);
          const pAccRaw = pData['accountSettings.v1'];
          if (!pAccRaw) continue;
          const pAcc = typeof pAccRaw === 'string' ? JSON.parse(pAccRaw) : pAccRaw;
          mergedSettings = mergedSettings ? mergeAccountSettings(mergedSettings, pAcc) : pAcc;
        } catch { /* ignora perfil com dado corrompido */ }
      }

      if (mergedSettings) {
        // Serializa de volta como string para manter consistência com o formato do payload
        parsedData = {
          ...parsedData,
          'accountSettings.v1': JSON.stringify(mergedSettings),
        };
      }
    }
  } catch { /* falha no merge nao bloqueia a resposta — retorna dados originais */ }

  return res.json({ backup: { createdAt: row.created_at, data: parsedData } });
});

app.get('/api/sync/backup/profile/:profileId/latest', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params?.profileId || '').trim();
  if (!profileId) {
    return res.status(400).json({ error: 'profileId invalido.' });
  }

  const row = dbGetProfileBackup(user.id, profileId);
  if (!row || !row.data) {
    return res.status(404).json({ error: 'Nenhum backup de perfil encontrado.' });
  }

  let parsedData;
  try { parsedData = JSON.parse(row.data); } catch { return res.status(500).json({ error: 'Backup corrompido.' }); }

  return res.json({ backup: { createdAt: row.created_at, profileId, data: parsedData } });
});

app.get('/api/sync/backup/profile/latest', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const row = dbGetLatestProfileBackup(user.id);
  if (!row || !row.data) {
    return res.status(404).json({ error: 'Nenhum backup de perfil encontrado.' });
  }

  let parsedData;
  try { parsedData = JSON.parse(row.data); } catch { return res.status(500).json({ error: 'Backup corrompido.' }); }

  return res.json({
    backup: {
      createdAt: row.created_at,
      profileId: String(row.profile_id || ''),
      data: parsedData,
    },
  });
});

// ---- Admin APIs -------------------------------------------------------------
app.use('/api/admin', (req, res, next) => {
  const startedAt = nowMs();
  res.on('finish', () => {
    if (req.path === '/login') {
      return;
    }
    pushAdminAudit('ADMIN_REQUEST', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: nowMs() - startedAt,
    });
  });
  next();
});

app.post('/api/admin/login', (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token || token !== ADMIN_BOOTSTRAP_TOKEN) {
    pushAdminAudit('ADMIN_LOGIN_FAILED', { ip: req.ip || '', hasToken: !!token });
    return res.status(401).json({ error: 'Token admin invalido.' });
  }
  pushAdminAudit('ADMIN_LOGIN_SUCCESS', { ip: req.ip || '' });
  return res.json({ token: buildAdminToken() });
});

app.get('/api/admin/overview', adminAuthMiddleware, (_req, res) => {
  return res.json({ overview: getAdminOverview() });
});

app.get('/api/admin/dashboard', adminAuthMiddleware, (_req, res) => {
  return res.json({ dashboard: buildAdminDashboardPayload() });
});

app.get('/api/admin/server/metrics', adminAuthMiddleware, (_req, res) => {
  return res.json({ metrics: buildAdminServerMetrics() });
});

app.get('/api/admin/players/monitor', adminAuthMiddleware, (_req, res) => {
  return res.json({ monitor: buildAdminPlayersMonitor() });
});

app.get('/api/admin/logs', adminAuthMiddleware, (req, res) => {
  const limitRaw = Number(req.query?.limit || 120);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 120;
  return res.json({
    generatedAt: nowIso(),
    logs: adminAuditLogs.slice(0, limit),
    health: buildHealthPayload(),
  });
});

app.get('/api/admin/ffmpeg/config', adminAuthMiddleware, (_req, res) => {
  return res.status(410).json({
    error: 'FFMPEG_REMOVIDO',
    message: 'Configuracoes FFmpeg/HLS foram removidas do servidor.',
    ts: nowIso(),
  });
});

app.put('/api/admin/ffmpeg/config', adminAuthMiddleware, (req, res) => {
  return res.status(410).json({
    error: 'FFMPEG_REMOVIDO',
    message: 'Configuracoes FFmpeg/HLS foram removidas do servidor.',
    ts: nowIso(),
  });
});

app.get('/api/admin/ffmpeg/logs', adminAuthMiddleware, (req, res) => {
  return res.status(410).json({
    error: 'FFMPEG_REMOVIDO',
    message: 'Logs de FFmpeg/HLS foram removidos do servidor.',
    ts: nowIso(),
  });
});

app.delete('/api/admin/ffmpeg/logs', adminAuthMiddleware, (_req, res) => {
  return res.status(410).json({
    error: 'FFMPEG_REMOVIDO',
    message: 'Logs de FFmpeg/HLS foram removidos do servidor.',
    ts: nowIso(),
  });
});

function getPublicOriginFromRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function buildUpstreamHeaders(req, fallbackUa) {
  const headers = {
    'user-agent': String(req.headers['user-agent'] || fallbackUa || 'AS-IPTV/1.0'),
    accept: String(req.headers.accept || '*/*'),
    'accept-encoding': 'identity',
  };
  if (req.headers.range) headers.range = String(req.headers.range);
  if (req.headers['if-none-match']) headers['if-none-match'] = String(req.headers['if-none-match']);
  if (req.headers['if-modified-since']) headers['if-modified-since'] = String(req.headers['if-modified-since']);
  return headers;
}

function isHlsByUrlOrType(targetUrl, contentType) {
  const ct = String(contentType || '').toLowerCase();
  return (
    ct.includes('application/vnd.apple.mpegurl') ||
    ct.includes('application/x-mpegurl') ||
    /\.m3u8(\?|$)/i.test(String(targetUrl || '')) ||
    /\/m3u8(\?|$)/i.test(String(targetUrl || '')) ||
    /[?&]output=m3u8(\b|&|$)/i.test(String(targetUrl || ''))
  );
}

function rewriteHlsManifest(manifestText, targetUrl, makeProxyUrl) {
  const base = new URL(targetUrl);

  const rewriteUri = (rawUri) => {
    const safe = String(rawUri || '').trim();
    if (!safe || /^data:/i.test(safe)) return safe;
    if (safe.startsWith('#')) return safe;
    const absolute = /^https?:\/\//i.test(safe) ? safe : new URL(safe, base).toString();
    return makeProxyUrl(absolute);
  };

  return String(manifestText || '')
    .split('\n')
    .map((line) => {
      const safeLine = String(line || '');
      if (!safeLine.trim()) return safeLine;
      if (safeLine.startsWith('#')) {
        return safeLine.replace(/URI="([^"]+)"/g, (_all, uri) => `URI="${rewriteUri(uri)}"`);
      }
      return rewriteUri(safeLine);
    })
    .join('\n');
}

function inferProxyBinaryContentType(targetUrl, upstreamCt) {
  const safeTarget = String(targetUrl || '').toLowerCase();
  const safeUpstreamCt = String(upstreamCt || '').toLowerCase();

  let inspectUrl = safeTarget;
  try {
    const wrapped = new URL(String(targetUrl || ''));
    const inner = wrapped.searchParams.get('url');
    if (inner) {
      inspectUrl = decodeURIComponent(inner).toLowerCase();
    }
  } catch {
    // mantém target original
  }

  if (/\.ts(\?|$)/i.test(inspectUrl) || /\/ts(\?|$)/i.test(inspectUrl) || /[?&]output=ts(\b|&|$)/i.test(inspectUrl)) {
    return 'video/mp2t';
  }
  if (/\.m4s(\?|$)/i.test(inspectUrl)) {
    return 'video/iso.segment';
  }
  if (/\.mp4(\?|$)/i.test(inspectUrl)) {
    return 'video/mp4';
  }

  return safeUpstreamCt || 'application/octet-stream';
}

async function proxyStreamRequest({ req, res, targetUrl, makeProxyUrl, fallbackUa, onBytes }) {
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: buildUpstreamHeaders(req, fallbackUa),
      redirect: 'follow',
    });
  } catch (error) {
    return res.status(502).json({ error: `Falha ao conectar no stream: ${String(error?.message || error || 'erro de rede')}` });
  }

  const upstreamCt = String(upstream.headers.get('content-type') || '').toLowerCase();
  const isHls = isHlsByUrlOrType(targetUrl, upstreamCt);

  if (isHls) {
    const manifestText = req.method === 'HEAD' ? '' : await upstream.text().catch(() => '');
    const looksLikeHlsManifest = /^\s*#EXTM3U/im.test(manifestText) || /#EXTINF:|#EXT-X-STREAM-INF:|#EXT-X-TARGETDURATION:/i.test(manifestText);

    if (req.method !== 'HEAD' && !looksLikeHlsManifest) {
      // Evita transformar HTML/erros upstream em manifesto invalido para VLC/player.
      res.status(upstream.status);
      res.setHeader('content-type', upstreamCt || 'text/plain; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('cache-control', 'no-store');
      return res.send(manifestText || `Upstream retornou payload nao-HLS (status ${upstream.status}).`);
    }

    const rewritten = req.method === 'HEAD' ? '' : rewriteHlsManifest(manifestText, targetUrl, makeProxyUrl);

    res.status(upstream.status);
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('expires', '0');
    if (req.method === 'HEAD') return res.end();
    return res.send(rewritten);
  }

  res.status(upstream.status);
  const passHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control', 'etag', 'last-modified'];
  for (const name of passHeaders) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('content-type', inferProxyBinaryContentType(targetUrl, upstreamCt));
  res.setHeader('access-control-allow-origin', '*');
  if (!res.getHeader('cache-control')) {
    res.setHeader('cache-control', 'no-store');
  }
  if (!res.getHeader('accept-ranges')) {
    res.setHeader('accept-ranges', 'bytes');
  }

  if (req.method === 'HEAD') {
    return res.end();
  }

  if (!upstream.body) {
    return res.end();
  }

  let bytesProxied = 0;
  const readable = Readable.fromWeb(upstream.body);
  readable.on('data', (chunk) => {
    bytesProxied += chunk?.length || 0;
    if (typeof onBytes === 'function') onBytes(bytesProxied);
  });
  readable.pipe(res);
}

app.all(['/api/admin/live-proxy', '/api/live-proxy'], async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Metodo nao suportado.' });
  }

  const targetUrl = String(req.query?.url || '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'URL de stream invalida.' });
  }

  const origin = getPublicOriginFromRequest(req);
  const makeProxyUrl = (absoluteUrl) =>
    `${origin}/api/live-proxy?url=${encodeURIComponent(String(absoluteUrl || '').trim())}`;

  return proxyStreamRequest({
    req,
    res,
    targetUrl,
    makeProxyUrl,
    fallbackUa: 'AS-IPTV-Admin/1.0',
  });
});

// ─── Proxy genérico (filmes, séries e ao vivo) ───────────────────────────────
// Uso: GET /api/proxy?url=<encoded>&sid=<sessionId>&uid=<userId>
// O parâmetro sid identifica a sessão proxy do perfil para rastreio no admin.
app.all('/api/proxy', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Metodo nao suportado.' });
  }

  const targetUrl = String(req.query?.url || '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'URL invalida para proxy.' });
  }

  // Rastreamento da sessão (opcional – não bloqueia se ausente)
  const sid = String(req.query?.sid || '').trim().slice(0, 64);
  const uid = String(req.query?.uid || '').trim().slice(0, 64);
  const profile = String(req.query?.profile || '').trim().slice(0, 80);
  const upstreamProxy = String(req.query?.p2 || '').trim().slice(0, 320);
  const dnsResolver = String(req.query?.dns || '').trim().slice(0, 160);
  if (sid) {
    upsertProxySession(sid, {
      userId: uid || 'anon',
      profileName: profile || 'Perfil',
      url: targetUrl,
      upstreamProxy,
      dnsResolver,
      contentType: 'proxy-direct',
      processingPath: 'direct',
      startedAt: proxyActiveSessions.has(sid) ? proxyActiveSessions.get(sid).startedAt : Date.now(),
    });
  }

  pushFfmpegEvent('DIRECT_PROXY_REQUEST', {
    sid,
    uid,
    profile,
    upstreamProxy,
    dnsResolver,
    targetUrl,
    via: 'api/proxy',
    method: req.method,
  });

  const origin = getPublicOriginFromRequest(req);
  const makeProxyUrl = (absoluteUrl) => {
    const base = `${origin}/api/proxy`;
    return (
      `${base}?sid=${encodeURIComponent(sid)}` +
      `&uid=${encodeURIComponent(uid)}` +
      `&profile=${encodeURIComponent(profile)}` +
      (upstreamProxy ? `&p2=${encodeURIComponent(upstreamProxy)}` : '') +
      (dnsResolver ? `&dns=${encodeURIComponent(dnsResolver)}` : '') +
      `&url=${encodeURIComponent(String(absoluteUrl || '').trim())}`
    );
  };

  return proxyStreamRequest({
    req,
    res,
    targetUrl,
    makeProxyUrl,
    fallbackUa: 'AS-IPTV/1.0',
    onBytes: (bytesProxied) => {
      if (sid) upsertProxySession(sid, { bytesProxied });
    },
  });
});

app.all('/api/proxy/hls*', (_req, res) => {
  return res.status(410).json({
    error: 'HLS_REMOVIDO',
    message: 'Endpoints HLS/FFmpeg foram descontinuados. Use /api/proxy.',
    ts: nowIso(),
  });
});

// Estatísticas de sessão proxy HLS por sid (usado pelo player para mostrar kbps)
app.get('/api/proxy/hls/stats', (req, res) => {
  const sid = String(req.query?.sid || '').trim().slice(0, 64);
  if (!sid) return res.status(400).json({ error: 'sid obrigatorio.' });

  const session = proxyActiveSessions.get(sid);
  if (!session) {
    return res.json({ sid, bytesProxied: 0, active: false });
  }

  const quality = String(session.quality || 'auto');
  const profile = HLS_QUALITY_PROFILES[quality] || HLS_QUALITY_PROFILES.auto;

  return res.json({
    sid,
    active: true,
    bytesProxied: Number(session.bytesProxied || 0),
    startedAt: Number(session.startedAt || 0),
    lastSeenAt: Number(session.lastSeenAt || 0),
    quality,
    qualityLabel: profile.label,
    bandwidth: profile.bandwidth,
    resolution: profile.resolution || '',
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HLS DEBUG — testa FFmpeg + conectividade com a URL de origem
// GET /api/proxy/hls/debug?url=<url>&duration=5
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// HLS PIPELINE CHECK — mostra estado do pipeline ativo + manifesto + segmentos
// GET /api/proxy/hls/pipeline-check?url=<url>&type=vod&quality=auto&ll=1&ar=1
// ────────────────────────────────────────────────────────────────────────────
app.get('/api/proxy/hls/pipeline-check', async (req, res) => {
  const targetUrl = String(req.query?.url || '').trim();
  const qualityKey = normalizeHlsQualityParam(req.query?.quality);
  const requestedContentType = String(req.query?.type || '').trim();
  const lowLatencyLive = parseBooleanQuery(req.query?.ll, true);
  const aggressiveReconnect = parseBooleanQuery(req.query?.ar, true);
  const resolvedContentType = await resolveEffectiveHlsContentType(targetUrl, requestedContentType);
  const contentType = resolvedContentType.effectiveType;
  const urlHash = safePipelineHash(targetUrl);

  const pipelineId = `${urlHash}-${qualityKey}${contentType === 'vod' ? '-vod' : ''}-${lowLatencyLive ? 'll1' : 'll0'}-${aggressiveReconnect ? 'ar1' : 'ar0'}`;
  const pipeline = proxyHlsPipelines.get(pipelineId);
  const relatedPipelineIds = [...proxyHlsPipelines.keys()].filter((id) => id.startsWith(`${urlHash}-`));

  if (!pipeline) {
    return res.json({
      ok: false,
      pipelineId,
      requestedContentType: resolvedContentType.requestedType,
      effectiveContentType: resolvedContentType.effectiveType,
      reason: resolvedContentType.reason,
      found: false,
      relatedPipelineIds,
      allPipelineIds: [...proxyHlsPipelines.keys()],
    });
  }

  const report = {
    ok: true,
    pipelineId,
    requestedContentType: resolvedContentType.requestedType,
    effectiveContentType: resolvedContentType.effectiveType,
    reason: resolvedContentType.reason,
    relatedPipelineIds,
    found: true,
    procAlive: !!(pipeline.proc && !pipeline.proc.killed),
    exitCode: pipeline.exitCode,
    lastError: pipeline.lastError,
    dirPath: pipeline.dirPath,
    manifestPath: pipeline.manifestPath,
    manifestExists: false,
    manifestContent: '',
    segments: [],
    filesOnDisk: [],
  };

  try {
    report.manifestExists = fs.existsSync(pipeline.manifestPath);
    if (report.manifestExists) {
      report.manifestContent = fs.readFileSync(pipeline.manifestPath, 'utf8');
    }
  } catch (e) {
    report.manifestContent = String(e?.message || e);
  }

  try {
    report.filesOnDisk = fs.readdirSync(pipeline.dirPath).filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'));
  } catch (_) {}

  // Para cada segmento no manifesto, verifica se existe no disco
  for (const line of report.manifestContent.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      const seg = path.basename(t);
      const fp = path.join(pipeline.dirPath, seg);
      let sizeBytes = null;
      try { sizeBytes = fs.statSync(fp).size; } catch (_) {}
      report.segments.push({ name: seg, exists: sizeBytes !== null, sizeBytes });
    }
  }

  res.json(report);
});

app.get('/api/proxy/hls/debug', async (req, res) => {
  const targetUrl = String(req.query?.url || '').trim();
  const durationSec = Math.max(1, Math.min(15, Number(req.query?.duration || 6)));

  const report = {
    ok: false,
    ffmpegBin: FFMPEG_BIN,
    ffmpegAvailable: false,
    ffmpegVersion: '',
    urlReachable: false,
    urlStatusCode: null,
    urlContentType: '',
    ffmpegStderr: '',
    ffmpegExitCode: null,
    segmentsProduced: 0,
    errors: [],
  };

  // 1) Verificar se FFmpeg está disponível
  try {
    const { execSync } = require('child_process');
    const ver = execSync(`"${FFMPEG_BIN}" -version 2>&1`, { timeout: 5000, encoding: 'utf8' });
    report.ffmpegAvailable = true;
    report.ffmpegVersion = (ver || '').split('\n')[0].trim();
  } catch (err) {
    report.errors.push(`FFmpeg indisponível em '${FFMPEG_BIN}': ${String(err?.message || err).slice(0, 300)}`);
    return res.status(200).json(report);
  }

  // 2) Testar alcançabilidade da URL de origem (se fornecida)
  if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(targetUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 AS-IPTV/1.0' },
        signal: ctrl.signal,
      }).catch(() =>
        fetch(targetUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 AS-IPTV/1.0', Range: 'bytes=0-1023' },
          signal: ctrl.signal,
        })
      );
      clearTimeout(timer);
      report.urlReachable = resp.ok || resp.status < 500;
      report.urlStatusCode = resp.status;
      report.urlContentType = resp.headers.get('content-type') || '';
    } catch (err) {
      report.urlReachable = false;
      report.errors.push(`URL inalcançável: ${String(err?.message || err).slice(0, 300)}`);
    }

    // 3) Rodar FFmpeg por N segundos e capturar stderr completo
    try {
      const stderrBuf = [];
      const tmpDir = path.join(HLS_PROXY_ROOT_DIR, '_debug_' + Date.now());
      ensureDir(tmpDir);
      const segPat = path.join(tmpDir, 'seg_%03d.ts');
      const manifestDbg = path.join(tmpDir, 'index.m3u8');

      const dbgArgs = [
        '-hide_banner', '-loglevel', 'verbose',
        '-probesize', '5000000', '-analyzeduration', '3000000',
        '-user_agent', 'Mozilla/5.0 AS-IPTV/1.0',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
        '-i', targetUrl,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '4',
        '-hls_flags', 'delete_segments+append_list+independent_segments',
        '-hls_segment_filename', segPat,
        manifestDbg,
      ];

      await new Promise((resolve) => {
        const proc = spawn(FFMPEG_BIN, dbgArgs, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr?.on('data', (chunk) => stderrBuf.push(String(chunk || '')));
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (_) {}
        }, durationSec * 1000);
        proc.on('exit', (code) => {
          clearTimeout(killTimer);
          report.ffmpegExitCode = code;
          resolve();
        });
        proc.on('error', (err) => {
          clearTimeout(killTimer);
          report.errors.push(`Erro ao iniciar FFmpeg: ${String(err?.message || err).slice(0, 300)}`);
          resolve();
        });
      });

      report.ffmpegStderr = stderrBuf.join('').slice(-4000);

      // Contar segmentos produzidos
      try {
        const files = fs.readdirSync(tmpDir);
        report.segmentsProduced = files.filter((f) => f.endsWith('.ts')).length;
      } catch (_) {}

      // Limpar arquivos temporários
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    } catch (err) {
      report.errors.push(`Falha no teste FFmpeg: ${String(err?.message || err).slice(0, 300)}`);
    }
  } else {
    report.errors.push('Forneça ?url=<url> para testar conectividade e FFmpeg.');
  }

  report.ok = report.ffmpegAvailable && report.urlReachable && report.segmentsProduced > 0;
  return res.status(200).json(report);
});

app.get('/api/proxy/hls/capabilities', (_req, res) => {
  const qualities = Object.values(HLS_QUALITY_PROFILES)
    .filter((profile) => profile && typeof profile === 'object' && profile.key !== 'auto')
    .map((profile) => ({
      key: String(profile.key || '').toLowerCase(),
      label: String(profile.label || profile.key || ''),
      bandwidth: Number(profile.bandwidth || 0),
      resolution: String(profile.resolution || ''),
    }))
    .filter((item) => item.key === 'high' || item.key === 'medium' || item.key === 'low')
    .sort((a, b) => b.bandwidth - a.bandwidth);

  return res.json({
    qualities: [{ key: 'auto', label: 'Auto' }, ...qualities],
    source: 'ffmpeg-runtime-config',
  });
});

// Compatibilidade: alguns ambientes Express/Proxy não casam rota em array com sufixo .m3u8.
// Mantemos endpoints explícitos que redirecionam para as rotas base preservando query-string.
app.get('/api/proxy/hls/master.m3u8', (req, res) => {
  const qIdx = String(req.originalUrl || '').indexOf('?');
  const query = qIdx >= 0 ? String(req.originalUrl).slice(qIdx) : '';
  return res.redirect(307, `/api/proxy/hls/master${query}`);
});

app.get('/api/proxy/hls/manifest.m3u8', (req, res) => {
  const qIdx = String(req.originalUrl || '').indexOf('?');
  const query = qIdx >= 0 ? String(req.originalUrl).slice(qIdx) : '';
  return res.redirect(307, `/api/proxy/hls/manifest${query}`);
});

app.get('/api/proxy/hls/master', async (req, res) => {
  const targetUrl = String(req.query?.url || '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'URL invalida para HLS fallback.' });
  }

  // Proteção anti-loop: rejeitar se targetUrl já é uma URL proxy HLS local
  if (/\/api\/proxy\/hls\/(master|manifest)/i.test(targetUrl)) {
    return res.status(400).json({ error: 'Loop detectado: targetUrl nao pode ser uma URL proxy HLS.' });
  }

  const sid = String(req.query?.sid || '').trim().slice(0, 64);
  const uid = String(req.query?.uid || '').trim().slice(0, 64);
  const profile = String(req.query?.profile || '').trim().slice(0, 80);
  const requestedContentType = String(req.query?.type || '').trim();
  const lowLatencyLive = parseBooleanQuery(req.query?.ll, true);
  const aggressiveReconnect = parseBooleanQuery(req.query?.ar, true);
  const resolvedContentType = await resolveEffectiveHlsContentType(targetUrl, requestedContentType);
  const contentType = resolvedContentType.effectiveType;

  if (sid) {
    upsertProxySession(sid, {
      userId: uid || 'anon',
      profileName: profile || 'Perfil',
      url: targetUrl,
      contentType: 'hls-master',
      processingPath: 'ffmpeg',
      hlsType: contentType,
      lowLatencyLive,
      aggressiveReconnect,
      startedAt: proxyActiveSessions.has(sid) ? proxyActiveSessions.get(sid).startedAt : Date.now(),
    });
  }
  const qualityKeys = contentType === 'vod'
    ? ['auto']
    : ['low', 'medium', 'high'];
  const sessionKey = sid || uid || profile || 'anon';

  pushFfmpegEvent('HLS_MASTER_REQUEST', {
    sid,
    uid,
    profile,
    targetUrl,
    requestedContentType: resolvedContentType.requestedType,
    contentType,
    contentTypeReason: resolvedContentType.reason,
    lowLatencyLive,
    aggressiveReconnect,
  });

  // Não bloqueia o master esperando todas as variantes ficarem prontas.
  // Cada /manifest prepara sua qualidade sob demanda, evitando falha total no boot.
  for (const qualityKey of qualityKeys) {
    try {
      const pipeline = ensureProxyHlsPipeline(targetUrl, sessionKey, qualityKey, contentType, {
        lowLatencyLive,
        aggressiveReconnect,
      });
      pipeline.lastSeenAt = Date.now();
    } catch (error) {
      pushFfmpegEvent('HLS_MASTER_VARIANT_START_FAIL', {
        sid,
        uid,
        profile,
        targetUrl,
        quality: qualityKey,
        contentType,
        detail: String(error?.message || error || 'erro desconhecido'),
      });
    }
  }

  const origin = getPublicOriginFromRequest(req);
  const makeVariantUrl = (qualityKey) => {
    return (
      `${origin}/api/proxy/hls/manifest` +
      `?sid=${encodeURIComponent(sid)}` +
      `&uid=${encodeURIComponent(uid)}` +
      `&profile=${encodeURIComponent(profile)}` +
      `&quality=${encodeURIComponent(String(qualityKey || 'auto'))}` +
      `&type=${encodeURIComponent(contentType)}` +
      `&ll=${encodeURIComponent(lowLatencyLive ? '1' : '0')}` +
      `&ar=${encodeURIComponent(aggressiveReconnect ? '1' : '0')}` +
      `&url=${encodeURIComponent(targetUrl)}`
    );
  };

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const qualityKey of qualityKeys) {
    const profileInfo = HLS_QUALITY_PROFILES[qualityKey];
    if (!profileInfo) continue;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${profileInfo.bandwidth},AVERAGE-BANDWIDTH=${profileInfo.averageBandwidth},RESOLUTION=${profileInfo.resolution}`
    );
    lines.push(makeVariantUrl(qualityKey));
  }

  res.setHeader('content-type', 'application/vnd.apple.mpegurl');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  return res.status(200).send(lines.join('\n'));
});

app.get('/api/proxy/hls/manifest', async (req, res) => {
  const targetUrl = String(req.query?.url || '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'URL invalida para HLS fallback.' });
  }

  // Proteção anti-loop: rejeitar se targetUrl já é uma URL proxy HLS local
  if (/\/api\/proxy\/hls\/(master|manifest)/i.test(targetUrl)) {
    return res.status(400).json({ error: 'Loop detectado: targetUrl nao pode ser uma URL proxy HLS.' });
  }

  const sid = String(req.query?.sid || '').trim().slice(0, 64);
  const uid = String(req.query?.uid || '').trim().slice(0, 64);
  const profile = String(req.query?.profile || '').trim().slice(0, 80);
  const requestedQualityKey = normalizeHlsQualityParam(req.query?.quality);
  const qualityKey = contentType === 'live' && requestedQualityKey === 'auto' ? 'medium' : requestedQualityKey;
  const requestedContentType = String(req.query?.type || '').trim();
  const lowLatencyLive = parseBooleanQuery(req.query?.ll, true);
  const aggressiveReconnect = parseBooleanQuery(req.query?.ar, true);
  const resolvedContentType = await resolveEffectiveHlsContentType(targetUrl, requestedContentType);
  const contentType = resolvedContentType.effectiveType;

  pushFfmpegEvent('HLS_MANIFEST_REQUEST', {
    sid,
    uid,
    profile,
    targetUrl,
    requestedContentType: resolvedContentType.requestedType,
    quality: requestedQualityKey,
    resolvedQuality: qualityKey,
    contentType,
    contentTypeReason: resolvedContentType.reason,
    lowLatencyLive,
    aggressiveReconnect,
  });

  if (sid) {
    upsertProxySession(sid, {
      userId: uid || 'anon',
      profileName: profile || 'Perfil',
      url: targetUrl,
      quality: qualityKey,
      contentType: `hls-${contentType}-${qualityKey}`,
      processingPath: 'ffmpeg',
      hlsType: contentType,
      lowLatencyLive,
      aggressiveReconnect,
      startedAt: proxyActiveSessions.has(sid) ? proxyActiveSessions.get(sid).startedAt : Date.now(),
    });
  }

  const origin = getPublicOriginFromRequest(req);
  const sessionKey = sid || uid || profile || 'anon';
  const attempts = [];
  const seenAttempts = new Set();
  const pushAttempt = (quality, type, timeoutMs) => {
    const key = `${String(type || '')}:${String(quality || '')}`;
    if (seenAttempts.has(key)) return;
    seenAttempts.add(key);
    attempts.push({ quality, type, timeoutMs });
  };

  const vodTimeoutMs = 30000;
  const liveTimeoutMs = 12000;
  const transcodeQualityOrder = ['medium', 'low', 'high'];

  // 1) pedido original
  pushAttempt(qualityKey, contentType, contentType === 'vod' ? vodTimeoutMs : liveTimeoutMs);

  // 2) se estiver em auto, tente variantes transcodificadas no mesmo tipo
  if (requestedQualityKey === 'auto') {
    for (const q of transcodeQualityOrder) {
      pushAttempt(q, contentType, contentType === 'vod' ? vodTimeoutMs : liveTimeoutMs);
    }
  }

  // 3) para VOD: tenta auto + transcode em live como fallback final
  if (contentType === 'vod') {
    pushAttempt('auto', 'live', liveTimeoutMs);
    for (const q of transcodeQualityOrder) {
      pushAttempt(q, 'live', liveTimeoutMs);
    }
  }

  let pipeline = null;
  let effectiveContentType = contentType;
  let effectiveQuality = qualityKey;
  const failures = [];

  for (const attempt of attempts) {
    let candidate = null;
    try {
      candidate = ensureProxyHlsPipeline(targetUrl, sessionKey, attempt.quality, attempt.type, {
        lowLatencyLive,
        aggressiveReconnect,
      });
      candidate.lastSeenAt = Date.now();
      await waitForHlsManifestPlayable(candidate.manifestPath, attempt.timeoutMs);
      await waitForHlsManifestSegmentWarmup(candidate.manifestPath, 2, attempt.timeoutMs);
      pipeline = candidate;
      effectiveContentType = attempt.type;
      effectiveQuality = attempt.quality;

      if (attempt.type !== contentType || attempt.quality !== qualityKey) {
        pushFfmpegEvent('HLS_MANIFEST_FALLBACK_SUCCESS', {
          sid,
          uid,
          profile,
          targetUrl,
          requestedQuality: requestedQualityKey,
          resolvedRequestedQuality: qualityKey,
          requestedType: contentType,
          effectiveQuality,
          effectiveType: effectiveContentType,
        });
      }
      break;
    } catch (error) {
      const detail = String(candidate?.lastError || error?.message || error || 'erro desconhecido');
      const dirSnapshot = getHlsDirSnapshot(candidate?.dirPath || '');
      pushFfmpegEvent('HLS_MANIFEST_FALLBACK_TRY_FAIL', {
        sid,
        uid,
        profile,
        targetUrl,
        requestedQuality: requestedQualityKey,
        resolvedRequestedQuality: qualityKey,
        requestedType: contentType,
        attemptQuality: attempt.quality,
        attemptType: attempt.type,
        detail,
        manifestPath: String(candidate?.manifestPath || ''),
        manifestExists: !!(candidate?.manifestPath && fs.existsSync(candidate.manifestPath)),
        dirSnapshot,
      });
      failures.push({
        quality: attempt.quality,
        type: attempt.type,
        detail: `${detail} | files=${(dirSnapshot.files || []).join(',') || 'none'}`,
      });
    }
  }

  if (!pipeline) {
    const detail = failures
      .map((item) => `${item.type}/${item.quality}: ${item.detail}`)
      .join(' | ');
    return res.status(502).json({
      error: 'Falha ao gerar HLS de fallback.',
      detail,
    });
  }

  let manifestText = '';
  try {
    manifestText = fs.readFileSync(pipeline.manifestPath, 'utf8');
  } catch (error) {
    return res.status(500).json({ error: `Falha ao ler manifesto HLS: ${String(error?.message || error)}` });
  }

  const makeFileUrl = (fileName) =>
    `${origin}/api/proxy/hls/file/${encodeURIComponent(pipeline.id)}/${encodeURIComponent(String(fileName || '').trim())}`;

  const rewritten = String(manifestText || '')
    .split('\n')
    .map((line) => {
      const safeLine = String(line || '');
      if (!safeLine.trim()) return safeLine;
      if (safeLine.startsWith('#')) {
        return safeLine.replace(/URI="([^"]+)"/g, (_all, uri) => {
          const fileName = path.basename(String(uri || '').trim());
          return `URI="${makeFileUrl(fileName)}"`;
        });
      }
      const fileName = path.basename(safeLine.trim());
      return makeFileUrl(fileName);
    })
    .join('\n');

  res.setHeader('content-type', 'application/vnd.apple.mpegurl');
  res.setHeader('x-hls-quality', effectiveQuality);
  res.setHeader('x-hls-type', effectiveContentType);
  res.setHeader('x-hls-pipeline-id', pipeline.id);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  return res.status(200).send(rewritten);
});

app.get('/api/proxy/hls/file/:pipelineId/:fileName', (req, res) => {
  const pipelineId = String(req.params?.pipelineId || '').trim();
  const fileName = path.basename(String(req.params?.fileName || '').trim());
  if (!pipelineId || !fileName) {
    return res.status(400).json({ error: 'Parâmetros inválidos do arquivo HLS.' });
  }

  const pipeline = proxyHlsPipelines.get(pipelineId);
  if (!pipeline) {
    return res.status(404).json({ error: 'Sessão HLS não encontrada ou expirada.' });
  }

  pipeline.lastSeenAt = Date.now();

  const filePath = path.join(pipeline.dirPath, fileName);
  if (!filePath.startsWith(pipeline.dirPath)) {
    return res.status(400).json({ error: 'Caminho de arquivo inválido.' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Segmento HLS ainda não está disponível.' });
  }

  const stat = fs.statSync(filePath);
  const isTs = /\.ts$/i.test(fileName);
  const isM3u8 = /\.m3u8$/i.test(fileName);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'no-store');
  if (isM3u8) {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
  } else if (isTs) {
    res.setHeader('content-type', 'video/mp2t');
  } else {
    res.setHeader('content-type', 'application/octet-stream');
  }

  const range = String(req.headers.range || '').trim();
  if (!range || !isTs) {
    res.setHeader('content-length', String(stat.size));
    return fs.createReadStream(filePath).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    res.status(416);
    return res.end();
  }

  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : stat.size - 1;
  const safeStart = Math.max(0, Math.min(start, stat.size - 1));
  const safeEnd = Math.max(safeStart, Math.min(end, stat.size - 1));
  const chunkSize = safeEnd - safeStart + 1;

  res.status(206);
  res.setHeader('content-range', `bytes ${safeStart}-${safeEnd}/${stat.size}`);
  res.setHeader('content-length', String(chunkSize));
  return fs.createReadStream(filePath, { start: safeStart, end: safeEnd }).pipe(res);
});

// Cliente: encerrar sessão proxy ativa (quando sai do player/app)
app.post('/api/proxy/session/close', (req, res) => {
  const sid = String(req.body?.sid || '').trim();
  if (!sid) {
    return res.status(400).json({ error: 'sid obrigatorio.' });
  }
  const deleted = proxyActiveSessions.delete(sid);
  return res.json({ ok: true, deleted });
});

// Admin: listar sessões proxy ativas
app.get('/api/admin/proxy-sessions', adminAuthMiddleware, (_req, res) => {
  pruneProxySessions();
  const sessions = Array.from(proxyActiveSessions.entries()).map(([id, s]) => ({
    id,
    userId: s.userId || 'anon',
    profileName: s.profileName || 'Perfil',
    url: s.url || '',
    processingPath: String(s.processingPath || ''),
    contentType: String(s.contentType || ''),
    quality: String(s.quality || 'auto'),
    hlsType: String(s.hlsType || ''),
    upstreamProxy: String(s.upstreamProxy || ''),
    dnsResolver: String(s.dnsResolver || ''),
    lowLatencyLive: s.lowLatencyLive !== false,
    aggressiveReconnect: s.aggressiveReconnect !== false,
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    lastSeenAt: s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : null,
    bytesProxied: s.bytesProxied || 0,
  }));
  return res.json({ sessions, total: sessions.length, ts: nowIso() });
});

// Admin: encerrar sessão proxy
app.delete('/api/admin/proxy-sessions/:id', adminAuthMiddleware, (req, res) => {
  const id = String(req.params?.id || '').trim();
  const deleted = proxyActiveSessions.delete(id);
  return res.json({ deleted });
});

app.get('/api/admin/plans', adminAuthMiddleware, (_req, res) => {
  return res.json({
    features: PLAN_FEATURE_IDS,
    plans: listPlanCatalog(true),
  });
});

app.put('/api/admin/plans/:id', adminAuthMiddleware, (req, res) => {
  const planId = String(req.params?.id || '').trim().toLowerCase();
  if (!planId) {
    return res.status(400).json({ error: 'id do plano invalido.' });
  }

  const current = planCatalogRowToObject(dbGetPlanCatalogById(planId));
  if (!current) {
    return res.status(404).json({ error: 'Plano nao encontrado no catalogo.' });
  }

  const maxProfilesRaw = Number(req.body?.maxProfiles ?? current.maxProfiles);
  const maxServersRaw = Number(req.body?.maxServers ?? current.maxServers);
  const maxProfiles = Number.isFinite(maxProfilesRaw) ? Math.max(-1, Math.floor(maxProfilesRaw)) : current.maxProfiles;
  const maxServers = Number.isFinite(maxServersRaw) ? Math.max(-1, Math.floor(maxServersRaw)) : current.maxServers;

  const rawFeatures = Array.isArray(req.body?.features) ? req.body.features : current.features;
  let features = Array.from(
    new Set(rawFeatures.map((item) => String(item || '').trim()).filter((item) => PLAN_FEATURE_IDS.includes(item)))
  );
  features = enforcePlanFeatureRules(planId, features);

  const next = {
    id: current.id,
    name: String(req.body?.name ?? (current.name || current.id)).trim() || current.id,
    tagline: String(req.body?.tagline ?? (current.tagline || '')).trim(),
    price: String(req.body?.price ?? (current.price || '')).trim(),
    priceNote: String(req.body?.priceNote ?? (current.priceNote || '')).trim(),
    color: String(req.body?.color ?? (current.color || '#7F89A8')).trim() || '#7F89A8',
    maxProfiles,
    maxServers,
    highlighted: req.body?.highlighted === true,
    enabled: req.body?.enabled !== false,
    sortOrder: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : current.sortOrder,
    features,
    updatedAt: nowIso(),
  };

  dbUpsertPlanCatalog(next);
  return res.json({ ok: true, plan: planCatalogRowToObject(dbGetPlanCatalogById(planId)) });
});

app.get('/api/admin/subscription/content', adminAuthMiddleware, (_req, res) => {
  const content = subscriptionPageConfigRowToObject(dbGetSubscriptionPageConfig())
    || {
      ...DEFAULT_SUBSCRIPTION_PAGE_CONTENT,
      updatedAt: nowIso(),
    };

  return res.json({ content });
});

app.put('/api/admin/subscription/content', adminAuthMiddleware, (req, res) => {
  const normalized = normalizeSubscriptionPageContent(req.body || {});
  const next = {
    ...normalized,
    updatedAt: nowIso(),
  };

  dbUpsertSubscriptionPageConfig(next);
  return res.json({ ok: true, content: subscriptionPageConfigRowToObject(dbGetSubscriptionPageConfig()) });
});

app.get('/api/admin/users', adminAuthMiddleware, (_req, res) => {
  const users = getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  const result = users.map((u) => {
    const plan = planRowToObject(dbGetPlan(u.id));
    const sync = syncPrefsRowToObject(dbGetSyncPrefs(u.id));
    const backup = dbGetBackup(u.id);
    const profileBackups = dbListProfileBackups(u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUri: u.avatar_uri || '',
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      lastLoginAt: u.last_login_at || '',
      plan: {
        planId: normalizePlanId(plan.planId),
        status: normalizePlanStatus(plan.status),
        enabled: plan.enabled !== false,
        paymentDueAt: plan.paymentDueAt || '',
        paymentAmount: plan.paymentAmount || '',
        updatedAt: plan.updatedAt || '',
      },
      sync: {
        consentEnabled: sync.consentEnabled === true,
        autoSyncEnabled: sync.autoSyncEnabled === true,
        lastSyncAt: sync.lastSyncAt || '',
        hasBackup: !!(backup && backup.data),
        backupAt: backup?.created_at || '',
        profileBackupCount: profileBackups.length,
      },
    };
  });
  return res.json({ users: result });
});

app.get('/api/admin/users/:id/details', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const plan = planRowToObject(dbGetPlan(user.id));
  const sync = syncPrefsRowToObject(dbGetSyncPrefs(user.id));
  const resolvedRealtime = resolveAdminRealtimeContextForUser(user.id);
  const backup = resolvedRealtime.backupPayload;
  const profileBackups = resolvedRealtime.profilePayloads;
  const pushTokens = dbListPushTokens(user.id).map((item) => ({
    expoPushToken: item.expo_push_token,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    lastSentAt: item.last_sent_at || '',
  }));

  return res.json({
    user: toPublicUser(user),
    plan: {
      planId: normalizePlanId(plan.planId),
      status: normalizePlanStatus(plan.status),
      paymentDueAt: plan.paymentDueAt || '',
      paymentHour: plan.paymentHour || '',
      paymentAmount: plan.paymentAmount || '',
      enabled: plan.enabled !== false,
      updatedAt: plan.updatedAt || '',
    },
    sync: {
      consentEnabled: sync.consentEnabled === true,
      autoSyncEnabled: sync.autoSyncEnabled === true,
      lastSyncAt: sync.lastSyncAt || '',
    },
    pushTokens,
    settings: resolvedRealtime.settings,
    backup,
    realtime: resolvedRealtime.realtime,
    realtimeSource: resolvedRealtime.source,
    profileBackups,
    overview: getAdminOverview(),
  });
});

app.post('/api/admin/users/:id/sessions/:profileId/disconnect', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params.profileId || '').trim();
  const accountKeyValue = String(req.body?.accountKey || '').trim();
  if (!profileId || !accountKeyValue) {
    return res.status(400).json({ error: 'profileId e accountKey sao obrigatorios.' });
  }

  try {
    getAdminAccountContextForUser(user.id, accountKeyValue);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  const disconnected = disconnectProfileSessionForAdmin(accountKeyValue, profileId);
  return res.json({ ok: disconnected, disconnected });
});

app.post('/api/admin/users/:id/sessions/:profileId/suspend', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params.profileId || '').trim();
  const accountKeyValue = String(req.body?.accountKey || '').trim();
  if (!profileId || !accountKeyValue) {
    return res.status(400).json({ error: 'profileId e accountKey sao obrigatorios.' });
  }

  try {
    getAdminAccountContextForUser(user.id, accountKeyValue);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  const sess = sessions[accountKeyValue]?.[profileId];
  if (!sess || !sess.watching) {
    return res.json({ ok: false, suspended: false, reason: 'PROFILE_NOT_WATCHING' });
  }

  const suspended = blockCurrentWatchingForProfile(
    accountKeyValue,
    profileId,
    'admin_manual_suspend',
    'Reproducao suspensa manualmente pelo painel admin'
  );

  return res.json({
    ok: suspended,
    suspended,
    blocked: getBlockedList(accountKeyValue),
    presence: presenceSnapshot(accountKeyValue),
  });
});

app.post('/api/admin/users/:id/activity/:profileId/clear', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params.profileId || '').trim();
  const accountKeyValue = String(req.body?.accountKey || '').trim();
  if (!profileId || !accountKeyValue) {
    return res.status(400).json({ error: 'profileId e accountKey sao obrigatorios.' });
  }

  try {
    getAdminAccountContextForUser(user.id, accountKeyValue);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  const activity = clearProfileActivityForAdmin(accountKeyValue, profileId, {
    searches: req.body?.searches !== false,
    watchHistory: req.body?.watchHistory !== false,
    penalty: req.body?.penalty !== false,
  });
  return res.json({ ok: true, activity });
});

app.put('/api/admin/users/:id/parental/rules', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const accountKeyValue = String(req.body?.accountKey || '').trim();
  if (!accountKeyValue) {
    return res.status(400).json({ error: 'accountKey obrigatorio.' });
  }

  try {
    getAdminAccountContextForUser(user.id, accountKeyValue);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  const rules = saveParentalRules(accountKeyValue, req.body?.rules || {});
  io.to(`parents:${accountKeyValue}`).emit('parental_rules_updated', rules);
  return res.json({ ok: true, rules });
});

app.post('/api/admin/users/:id/parental/block', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const accountKeyValue = String(req.body?.accountKey || '').trim();
  const contentId = String(req.body?.contentId || '').trim();
  const contentTitle = String(req.body?.contentTitle || '').trim();
  const targetProfileId = String(req.body?.targetProfileId || '').trim();
  if (!accountKeyValue || !contentId) {
    return res.status(400).json({ error: 'accountKey e contentId sao obrigatorios.' });
  }

  try {
    getAdminAccountContextForUser(user.id, accountKeyValue);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  if (!blockedContent[accountKeyValue]) blockedContent[accountKeyValue] = new Set();
  blockedContent[accountKeyValue].add(contentId);

  const targetSess = sessions[accountKeyValue]?.[targetProfileId];
  if (targetSess?.socketId) {
    io.to(targetSess.socketId).emit('content_blocked', { contentId, contentTitle });
  }
  io.to(accountKeyValue).emit('parental_blocks_updated', getBlockedList(accountKeyValue));

  return res.json({ ok: true, blocked: getBlockedList(accountKeyValue) });
});

app.post('/api/admin/users/:id/parental/unblock', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const accountKeyValue = String(req.body?.accountKey || '').trim();
  const contentId = String(req.body?.contentId || '').trim();
  if (!accountKeyValue || !contentId) {
    return res.status(400).json({ error: 'accountKey e contentId sao obrigatorios.' });
  }

  try {
    getAdminAccountContextForUser(user.id, accountKeyValue);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  blockedContent[accountKeyValue]?.delete(contentId);
  io.to(accountKeyValue).emit('parental_blocks_updated', getBlockedList(accountKeyValue));
  return res.json({ ok: true, blocked: getBlockedList(accountKeyValue) });
});

app.patch('/api/admin/users/:id/profiles/:profileId', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params.profileId || '').trim();
  if (!profileId) return res.status(400).json({ error: 'profileId invalido.' });

  const row = dbGetBackup(user.id);
  let editable;
  try {
    editable = loadEditableAccountSettingsFromBackup(row);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  const profiles = Array.isArray(editable.accountSettings.profiles) ? [...editable.accountSettings.profiles] : [];
  const index = profiles.findIndex((item) => String(item?.id || '') === profileId);
  if (index < 0) return res.status(404).json({ error: 'Perfil nao encontrado no backup.' });

  const current = profiles[index];
  const nextProfile = {
    ...current,
    name: typeof req.body?.name === 'string' ? String(req.body.name).trim() || current.name : current.name,
    enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : current.enabled !== false,
    kidsMode: typeof req.body?.kidsMode === 'boolean' ? req.body.kidsMode : current.kidsMode === true,
    pinEnabled: typeof req.body?.pinEnabled === 'boolean' ? req.body.pinEnabled : current.pinEnabled === true,
    pin: typeof req.body?.pin === 'string' ? String(req.body.pin).trim() : current.pin,
    isPrimary: typeof req.body?.isPrimary === 'boolean' ? req.body.isPrimary : current.isPrimary === true,
    avatarUri: typeof req.body?.avatarUri === 'string' ? String(req.body.avatarUri).trim() : current.avatarUri || '',
    updatedAt: nowIso(),
  };

  profiles[index] = nextProfile;
  const enabledProfiles = profiles.filter((item) => item?.enabled !== false);
  if (!enabledProfiles.length) {
    return res.status(400).json({ error: 'Mantenha pelo menos um perfil ativo.' });
  }

  if (!profiles.some((item) => item?.isPrimary === true)) {
    profiles[0] = { ...profiles[0], isPrimary: true, updatedAt: nowIso() };
  }

  editable.accountSettings.profiles = profiles;
  if (req.body?.setActive === true) {
    editable.accountSettings.activeProfileId = profileId;
  }

  if (String(editable.accountSettings.activeProfileId || '') === profileId && nextProfile.enabled === false) {
    editable.accountSettings.activeProfileId = String(enabledProfiles[0]?.id || profiles[0]?.id || '');
  }

  editable.rawMap['accountSettings.v1'] = JSON.stringify(editable.accountSettings);
  const updatedAt = nowIso();
  dbUpsertBackup(user.id, updatedAt, editable.rawMap);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(updatedAt, user.id);

  return res.json({ ok: true, profile: nextProfile, backupAt: updatedAt });
});

app.delete('/api/admin/users/:id/profiles/:profileId', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const profileId = String(req.params.profileId || '').trim();
  if (!profileId) return res.status(400).json({ error: 'profileId invalido.' });

  const row = dbGetBackup(user.id);
  let editable;
  try {
    editable = loadEditableAccountSettingsFromBackup(row);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  const profiles = Array.isArray(editable.accountSettings.profiles) ? [...editable.accountSettings.profiles] : [];
  const target = profiles.find((item) => String(item?.id || '') === profileId);
  if (!target) return res.status(404).json({ error: 'Perfil nao encontrado no backup.' });
  if (profiles.length <= 1) return res.status(400).json({ error: 'Mantenha pelo menos um perfil.' });
  if (target.isPrimary === true && profiles.filter((item) => item?.isPrimary === true).length <= 1) {
    return res.status(400).json({ error: 'Mantenha pelo menos um perfil principal.' });
  }

  const nextProfiles = profiles.filter((item) => String(item?.id || '') !== profileId);
  editable.accountSettings.profiles = nextProfiles;
  if (String(editable.accountSettings.activeProfileId || '') === profileId) {
    editable.accountSettings.activeProfileId = String(nextProfiles[0]?.id || '');
  }

  editable.rawMap['accountSettings.v1'] = JSON.stringify(editable.accountSettings);
  const updatedAt = nowIso();
  dbUpsertBackup(user.id, updatedAt, editable.rawMap);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(updatedAt, user.id);

  return res.json({ ok: true, backupAt: updatedAt });
});

app.patch('/api/admin/users/:id/plan', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const current = planRowToObject(dbGetPlan(user.id));
  const plan = {
    planId: normalizePlanId(req.body?.planId || current.planId),
    status: normalizePlanStatus(req.body?.status || current.status || 'unknown'),
    paymentDueAt: String(req.body?.paymentDueAt ?? current.paymentDueAt ?? ''),
    paymentHour: String(req.body?.paymentHour ?? current.paymentHour ?? ''),
    paymentAmount: String(req.body?.paymentAmount ?? current.paymentAmount ?? ''),
    enabled: req.body?.enabled !== false,
    updatedAt: nowIso(),
  };
  dbUpsertPlan(user.id, plan);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  notifyPlanChange(user, plan, { previousPlanId: current.planId }).catch((error) => {
    logAuth('PLAN_PUSH_FAILED', { userId: user.id, error: String(error?.message || error) });
  });

  return res.json({ ok: true, plan });
});

app.patch('/api/admin/users/:id/active', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const active = req.body?.active !== false;
  const current = planRowToObject(dbGetPlan(user.id));
  const plan = {
    ...current,
    enabled: active,
    status: active ? normalizePlanStatus(current.status) : 'expired',
    updatedAt: nowIso(),
  };
  dbUpsertPlan(user.id, plan);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  notifyPlanChange(user, plan, { previousPlanId: current.planId }).catch((error) => {
    logAuth('PLAN_PUSH_FAILED', { userId: user.id, error: String(error?.message || error) });
  });

  return res.json({ ok: true, plan });
});

// ---- Realtime APIs ----------------------------------------------------------
app.post('/api/session/start', (req, res) => {
  const { username, serverUrl, profileId, profileName, kidsMode, deviceId } = req.body;
  if (!username || !serverUrl || !profileId || !deviceId) {
    return res.status(400).json({ error: 'Campos obrigatorios faltando' });
  }

  const key = accountKey(username, serverUrl);
  if (!sessions[key]) sessions[key] = {};

  const existing = sessions[key][profileId];
  const isStale = !existing || nowMs() - existing.lastSeen > 45000;

  if (existing && existing.deviceId !== deviceId && !isStale && existing.online) {
    return res.status(409).json({
      error: 'SESSION_LOCKED',
      message: `O perfil "${profileName}" ja esta ativo em outro dispositivo.`,
    });
  }

  const token = jwt.sign(
    { key, profileId, profileName, kidsMode: !!kidsMode, deviceId },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  sessions[key][profileId] = {
    deviceId,
    socketId: null,
    online: false,
    watching: null,
    profileName,
    kidsMode: !!kidsMode,
    connectedAt: nowMs(),
    lastSeen: nowMs(),
  };

  return res.json({ token });
});

app.post('/api/session/end', rtAuthMiddleware, (req, res) => {
  const { key, profileId, deviceId } = req.auth;
  const sess = sessions[key]?.[profileId];
  if (sess && sess.deviceId === deviceId) {
    delete sessions[key][profileId];
    io.to(key).emit('presence_update', presenceSnapshot(key));
  }
  return res.json({ ok: true });
});

app.post('/api/session/heartbeat', rtAuthMiddleware, (req, res) => {
  const { key, profileId, profileName, kidsMode, deviceId } = req.auth;

  if (!sessions[key]) sessions[key] = {};
  if (!sessions[key][profileId]) {
    sessions[key][profileId] = {
      deviceId,
      socketId: null,
      online: true,
      watching: null,
      profileName,
      kidsMode: !!kidsMode,
      connectedAt: nowMs(),
      lastSeen: nowMs(),
    };
  }

  const sess = sessions[key][profileId];
  if (sess.deviceId !== deviceId) {
    return res.status(409).json({ error: 'SESSION_LOCKED', message: `Perfil "${profileName}" ativo em outro dispositivo.` });
  }

  sess.online = true;
  sess.lastSeen = nowMs();
  sess.profileName = profileName;
  sess.kidsMode = !!kidsMode;
  io.to(key).emit('presence_update', presenceSnapshot(key));
  return res.json({ ok: true });
});

app.post('/api/activity/watching/start', rtAuthMiddleware, (req, res) => {
  const { key, profileId, profileName, kidsMode, deviceId } = req.auth;
  const contentId = String(req.body?.contentId || '').trim();
  const contentTitle = String(req.body?.contentTitle || 'Conteudo').trim();
  const contentType = String(req.body?.contentType || 'movie').trim();
  const previewUrl = String(req.body?.previewUrl || '').trim().slice(0, 2400);
  const posterUrl = String(req.body?.posterUrl || '').trim().slice(0, 1200);
  const positionMs = Math.max(0, Number(req.body?.positionMs || 0));
  const durationMs = Math.max(0, Number(req.body?.durationMs || 0));

  if (!contentId) {
    return res.status(400).json({ error: 'contentId obrigatorio' });
  }

  if (!sessions[key]) sessions[key] = {};
  if (!sessions[key][profileId]) {
    sessions[key][profileId] = {
      deviceId,
      socketId: null,
      online: true,
      watching: null,
      profileName,
      kidsMode: !!kidsMode,
      connectedAt: nowMs(),
      lastSeen: nowMs(),
    };
  }

  const sess = sessions[key][profileId];
  if (sess.deviceId !== deviceId) {
    return res.status(409).json({ error: 'SESSION_LOCKED', message: `Perfil "${profileName}" ativo em outro dispositivo.` });
  }

  const prevWatching = sess.watching && typeof sess.watching === 'object' ? sess.watching : null;
  const sameContent = !!(prevWatching && String(prevWatching.contentId || '') === contentId);
  const since = sameContent && Number(prevWatching?.since || 0) > 0
    ? Number(prevWatching.since)
    : nowMs();

  const bucket = ensureActivityBucket(key, profileId);
  if (isProfilePenaltyBlocked(key, profileId)) {
    return res.status(423).json({
      error: 'PROFILE_BLOCKED',
      reasonType: 'profile_penalty_lock',
      reasonMessage: 'Perfil temporariamente bloqueado por controle parental agressivo',
    });
  }

  sess.online = true;
  sess.lastSeen = nowMs();
  sess.watching = {
    contentId,
    contentTitle,
    contentType,
    since,
    previewUrl: previewUrl || String(prevWatching?.previewUrl || '').trim(),
    posterUrl: posterUrl || String(prevWatching?.posterUrl || '').trim(),
    positionMs: positionMs > 0 ? positionMs : Math.max(0, Number(prevWatching?.positionMs || 0)),
    durationMs: durationMs > 0 ? durationMs : Math.max(0, Number(prevWatching?.durationMs || 0)),
  };

  if (!sameContent || !bucket.activeWatchStart) {
    bucket.activeWatchStart = { ...sess.watching };
  }

  io.to(key).emit('presence_update', presenceSnapshot(key));
  if (kidsMode) {
    io.to(`parents:${key}`).emit('child_watching', {
      profileId,
      profileName,
      contentId,
      contentTitle,
      contentType,
      since: sess.watching.since,
      previewUrl: sess.watching.previewUrl || '',
      posterUrl: sess.watching.posterUrl || '',
      positionMs: sess.watching.positionMs || 0,
      durationMs: sess.watching.durationMs || 0,
    });

    applyAggressiveRulesForProfile(key, profileId);
  }

  return res.json({ ok: true });
});

app.post('/api/activity/watching/stop', rtAuthMiddleware, (req, res) => {
  const { key, profileId, profileName, kidsMode, deviceId } = req.auth;

  const sess = sessions[key]?.[profileId];
  if (!sess) {
    return res.json({ ok: true });
  }

  if (sess.deviceId !== deviceId) {
    return res.status(409).json({ error: 'SESSION_LOCKED', message: `Perfil "${profileName}" ativo em outro dispositivo.` });
  }

  finalizeWatchSession(key, profileId, sess.watching);
  sess.watching = null;
  sess.online = true;
  sess.lastSeen = nowMs();
  io.to(key).emit('presence_update', presenceSnapshot(key));

  if (kidsMode) {
    applyAggressiveRulesForProfile(key, profileId);
  }

  return res.json({ ok: true });
});

app.get('/api/presence', rtAuthMiddleware, (req, res) => {
  return res.json({ profiles: presenceSnapshot(req.auth.key) });
});

app.post('/api/parental/block', rtAuthMiddleware, (req, res) => {
  const { key } = req.auth;
  const { targetProfileId, contentId, contentTitle } = req.body;
  if (!contentId) return res.status(400).json({ error: 'contentId obrigatorio' });

  if (!blockedContent[key]) blockedContent[key] = new Set();
  blockedContent[key].add(contentId);

  const targetSess = sessions[key]?.[targetProfileId];
  if (targetSess?.socketId) {
    io.to(targetSess.socketId).emit('content_blocked', { contentId, contentTitle });
  }

  io.to(`parents:${key}`).emit('parental_block_applied', {
    contentId,
    contentTitle,
    targetProfileId,
    blockedAt: nowIso(),
  });

  return res.json({ ok: true });
});

app.post('/api/parental/unblock', rtAuthMiddleware, (req, res) => {
  const { key } = req.auth;
  const { contentId } = req.body;
  blockedContent[key]?.delete(contentId);
  io.to(key).emit('parental_blocks_updated', getBlockedList(key));
  return res.json({ ok: true });
});

app.get('/api/parental/blocks', rtAuthMiddleware, (req, res) => {
  return res.json({ blocked: getBlockedList(req.auth.key) });
});

app.get('/api/parental/rules', rtAuthMiddleware, (req, res) => {
  const rules = getParentalRules(req.auth.key);
  return res.json({ rules });
});

app.put('/api/parental/rules', rtAuthMiddleware, (req, res) => {
  const rules = saveParentalRules(req.auth.key, req.body || {});
  io.to(`parents:${req.auth.key}`).emit('parental_rules_updated', rules);
  return res.json({ rules });
});

app.post('/api/activity/search', rtAuthMiddleware, (req, res) => {
  const { key, profileId, kidsMode } = req.auth;
  const query = String(req.body?.query || '').trim();
  if (!query || query.length < 2) {
    return res.status(400).json({ error: 'query obrigatoria' });
  }

  const bucket = ensureActivityBucket(key, profileId);
  const entry = {
    query: query.slice(0, 120),
    at: nowIso(),
  };
  bucket.searches.unshift(entry);
  bucket.searches = bucket.searches.slice(0, 180);

  if (kidsMode) {
    io.to(`parents:${key}`).emit('child_search', {
      profileId,
      profileName: sessions[key]?.[profileId]?.profileName || profileId,
      query: entry.query,
      at: entry.at,
    });

    const rules = getParentalRules(key);
    if (rules.aggressiveMode && rules.forbiddenSearchKeywords.length) {
      const normalizedQuery = entry.query.toLowerCase();
      const matchedKeyword = rules.forbiddenSearchKeywords.find((keyword) => normalizedQuery.includes(keyword));

      if (matchedKeyword) {
        const bucket = ensureActivityBucket(key, profileId);
        if (canTriggerRule(bucket, `search-${matchedKeyword}`, 90000)) {
          applyViolation(
            key,
            profileId,
            'forbidden_search',
            `Busca proibida detectada: ${matchedKeyword}`,
            rules.autoBlockOnForbiddenSearch
          );
        }
      }
    }
  }

  return res.json({ ok: true });
});

app.get('/api/parental/activity/:profileId', rtAuthMiddleware, (req, res) => {
  const { key } = req.auth;
  const profileId = String(req.params.profileId || '').trim();
  if (!profileId) {
    return res.status(400).json({ error: 'profileId obrigatorio' });
  }

  const current = sessions[key]?.[profileId];
  const activity = getProfileActivity(key, profileId);
  return res.json({
    profileId,
    profileName: current?.profileName || profileId,
    activity,
  });
});

app.post('/api/push-token', rtAuthMiddleware, (req, res) => {
  const { key, profileId } = req.auth;
  const { token } = req.body;
  if (token) {
    if (!pushTokens[key]) pushTokens[key] = {};
    pushTokens[key][profileId] = token;
  }
  return res.json({ ok: true });
});

setInterval(() => {
  const staleThreshold = 90000;
  const purgeThreshold = 10 * 60 * 1000;
  const now = nowMs();

  for (const key of Object.keys(sessions)) {
    for (const [profileId, sess] of Object.entries(sessions[key])) {
      if (sess.online && now - sess.lastSeen > staleThreshold) {
        finalizeWatchSession(key, profileId, sess.watching);
        sess.online = false;
        sess.socketId = null;
        sess.watching = null;
      }

      if (!sess.online && now - sess.lastSeen > purgeThreshold) {
        delete sessions[key][profileId];
      }
    }
    if (Object.keys(sessions[key]).length === 0) {
      delete sessions[key];
    }
  }
}, 120000);

setInterval(() => {
  for (const key of Object.keys(sessions)) {
    for (const [profileId, sess] of Object.entries(sessions[key])) {
      if (!sess.online || !sess.kidsMode || !sess.watching) continue;
      applyAggressiveRulesForProfile(key, profileId);
    }
  }
}, 15000);

setInterval(() => {
  const now = nowMs();
  const drift = now - eventLoopLagLastTick - 5000;
  eventLoopLagLastTick = now;
  eventLoopLagMs = Math.max(0, Math.round(drift));
}, 5000);

setInterval(() => {
  pruneProxyHlsPipelines();
}, 20_000);

// Limpa segmentos de pipelines live que não são mais referenciados no manifesto.
// O grace period de 30s garante que o player tenha tempo de baixar os segmentos
// antes de serem deletados (substitui delete_segments do FFmpeg).
function pruneOldHlsSegments() {
  const gracePeriodMs = 30_000;
  const now = Date.now();
  for (const [, state] of proxyHlsPipelines) {
    if (!state || !state.dirPath || !state.manifestPath || state.contentType === 'vod') continue;
    try {
      if (!fs.existsSync(state.manifestPath)) continue;
      const manifestText = fs.readFileSync(state.manifestPath, 'utf8');
      const referenced = new Set();
      for (const line of manifestText.split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#')) referenced.add(path.basename(t));
      }
      for (const file of fs.readdirSync(state.dirPath)) {
        if (!file.endsWith('.ts')) continue;
        if (referenced.has(file)) continue;
        const fp = path.join(state.dirPath, file);
        try {
          const st = fs.statSync(fp);
          if (now - st.mtimeMs > gracePeriodMs) fs.unlinkSync(fp);
        } catch (_) {}
      }
    } catch (_) {}
  }
}

setInterval(pruneOldHlsSegments, 5_000);

httpServer.listen(PORT, () => {
  ensurePublicDirs();
  getDb(); // initialize SQLite on startup
  console.log(`AS-IPTV server rodando na porta ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log(`DB:     ${DB_PATH}`);
});
