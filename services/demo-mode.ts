import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';
import * as FileSystem from 'expo-file-system/legacy';

const DEMO_MODE_KEY = 'demoModeEnabled';

const demoMovies = [
  {
    stream_id: '9001',
    title: 'Big Buck Bunny',
    name: 'Big Buck Bunny',
    category_id: '501',
    category_name: 'Animacao',
    stream_icon: 'https://i.imgur.com/8Km9tLL.jpg',
    rating: '8.2',
    genre: 'Animacao, Familia',
    duration: '10 min',
    plot: 'Curta de animacao em alta qualidade para teste do player.',
    direct_source: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
  {
    stream_id: '9002',
    title: 'Elephants Dream',
    name: 'Elephants Dream',
    category_id: '501',
    category_name: 'Animacao',
    stream_icon: 'https://i.imgur.com/Q8bKQkV.jpg',
    rating: '7.8',
    genre: 'Animacao, Sci-Fi',
    duration: '10 min',
    plot: 'Conteudo de demonstracao para validacao em loja.',
    direct_source: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  },
  {
    stream_id: '9003',
    title: 'For Bigger Blazes',
    name: 'For Bigger Blazes',
    category_id: '502',
    category_name: 'Trailer',
    stream_icon: 'https://i.imgur.com/u5KXG7m.jpg',
    rating: '7.1',
    genre: 'Trailer',
    duration: '1 min',
    plot: 'Trailer curto para testar busca, detalhes e progresso.',
    direct_source: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  },
  {
    stream_id: '9004',
    title: 'For Bigger Escapes',
    name: 'For Bigger Escapes',
    category_id: '502',
    category_name: 'Trailer',
    stream_icon: 'https://i.imgur.com/7Xq8z9u.jpg',
    rating: '7.3',
    genre: 'Trailer',
    duration: '1 min',
    plot: 'Video de demonstracao para navegacao de cards e player.',
    direct_source: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  },
];

const demoSeries = [
  {
    series_id: '9101',
    title: 'Demo Space Stories',
    name: 'Demo Space Stories',
    category_id: '601',
    category_name: 'Ficcao',
    stream_icon: 'https://i.imgur.com/R6Yf5Rb.jpg',
    rating: '8.0',
    genre: 'Ficcao',
    plot: 'Serie de demonstração para testar temporadas e episodios.',
  },
  {
    series_id: '9102',
    title: 'Demo Nature Files',
    name: 'Demo Nature Files',
    category_id: '602',
    category_name: 'Documentario',
    stream_icon: 'https://i.imgur.com/ovr0NAF.jpg',
    rating: '8.4',
    genre: 'Documentario',
    plot: 'Serie demo para validar fluxo completo do app.',
  },
];

const demoSeriesEpisodes: Record<string, { title: string; url: string }[]> = {
  '9101': [
    {
      title: 'Origem Estelar',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    },
    {
      title: 'Viagem Orbital',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    },
    {
      title: 'Sinais Distantes',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
    },
  ],
  '9102': [
    {
      title: 'Florestas Profundas',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    },
    {
      title: 'Vida Marinha',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    },
    {
      title: 'Montanhas e Ventos',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4',
    },
  ],
};

const demoLive = [
  {
    stream_id: '9201',
    name: 'Demo News',
    title: 'Demo News',
    category_id: '701',
    category_name: 'Noticias',
    stream_icon: 'https://i.imgur.com/5QF7m6Q.png',
    direct_source: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
  },
  {
    stream_id: '9202',
    name: 'Demo Sports',
    title: 'Demo Sports',
    category_id: '702',
    category_name: 'Esportes',
    stream_icon: 'https://i.imgur.com/Zk9nR0w.png',
    direct_source: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  },
  {
    stream_id: '9203',
    name: 'Demo Music',
    title: 'Demo Music',
    category_id: '703',
    category_name: 'Musica',
    stream_icon: 'https://i.imgur.com/3O7Q9YB.png',
    direct_source: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
  },
];

const demoVodCategories = [
  { category_id: '501', category_name: 'Animacao' },
  { category_id: '502', category_name: 'Trailer' },
];

const demoSeriesCategories = [
  { category_id: '601', category_name: 'Ficcao' },
  { category_id: '602', category_name: 'Documentario' },
];

const demoLiveCategories = [
  { category_id: '701', category_name: 'Noticias' },
  { category_id: '702', category_name: 'Esportes' },
  { category_id: '703', category_name: 'Musica' },
];

const writeDemoFile = async (fileName: string, data: unknown) => {
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(data));
};

export async function isDemoModeEnabled() {
  const raw = await getDbValue<string>(DEMO_MODE_KEY);
  return raw === '1';
}

export async function enableDemoMode() {
  await Promise.all([
    writeDemoFile('iptv_vodStreams.json', demoMovies),
    writeDemoFile('iptv_vodCategories.json', demoVodCategories),
    writeDemoFile('iptv_series.json', demoSeries),
    writeDemoFile('iptv_seriesCategories.json', demoSeriesCategories),
    writeDemoFile('iptv_liveStreams.json', demoLive),
    writeDemoFile('iptv_liveCategories.json', demoLiveCategories),
    writeDemoFile('iptv_epg.json', []),
  ]);

  await Promise.all([
    setDbValue('name', 'Demo Reviewer'),
    setDbValue('url', 'https://demo.local'),
    setDbValue('username', 'demo'),
    setDbValue('password', 'demo'),
    setDbValue(DEMO_MODE_KEY, '1'),
    setDbValue('catalog.lastUpdate.v1', new Date().toISOString()),
  ]);
}

export async function disableDemoMode() {
  await removeDbValue(DEMO_MODE_KEY);
}

export function getDemoSeriesInfo(seriesId: string) {
  const series = demoSeries.find((item) => item.series_id === seriesId);
  const episodes = demoSeriesEpisodes[seriesId] || [];

  const mappedEpisodes = episodes.map((item, index) => {
    const episodeNum = index + 1;
    return {
      id: item.url,
      episode_num: episodeNum,
      title: item.title,
      container_extension: 'mp4',
      info: {
        plot: `Episodio demo ${episodeNum} para avaliacao da loja.`,
        duration: '10 min',
        movie_image: series?.stream_icon || '',
        releasedate: '-',
      },
    };
  });

  return {
    info: {
      name: series?.title || 'Serie Demo',
      cover: series?.stream_icon || '',
      plot: series?.plot || 'Serie de demonstracao',
      genre: series?.genre || 'Demo',
      rating: series?.rating || 'N/A',
      releaseDate: '-',
    },
    seasons: [{ season_number: 1 }],
    episodes: {
      '1': mappedEpisodes,
    },
  };
}

export function getDemoVodInfo(vodId: string) {
  const movie = demoMovies.find((item) => item.stream_id === vodId);

  return {
    info: {
      name: movie?.title || 'Filme Demo',
      plot: movie?.plot || 'Conteudo de demonstracao para avaliacao da loja.',
      duration: movie?.duration || '10 min',
      movie_image: movie?.stream_icon || '',
      rating: movie?.rating || 'N/A',
      genre: movie?.genre || 'Demo',
      year: '2026',
      cast: 'Elenco Demo',
      director: 'Direcao Demo',
      releasedate: '2026-01-01',
    },
  };
}
