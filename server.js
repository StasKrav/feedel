// ============================================
// RSS Aggregator Backend Server
// ============================================

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');

const app = express();
const parser = new Parser({
    timeout: 10000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    }
});

// Кэш на 15 минут
const cache = new NodeCache({ stdTTL: 900 });

app.use(cors());
app.use(express.json());

// Источники новостей
const SOURCES = [
    { id: 'habr', name: 'Хабр', url: 'https://habr.com/ru/rss/all/all/?fl=ru', color: '#65C3DF' },
    { id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss.asp', color: '#1A73E8' },
    { id: 'kommersant', name: 'Коммерсантъ', url: 'https://www.kommersant.ru/RSS/main.xml', color: '#E53935' },
    { id: 'rbc', name: 'РБК', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', color: '#4CAF50' },
    { id: 'lenta', name: 'Lenta.ru', url: 'https://lenta.ru/rss', color: '#9C27B0' },
    { id: 'rt', name: 'RT на русском', url: 'https://russian.rt.com/rss', color: '#FF5722' },
    { id: 'vedomosti', name: 'Ведомости', url: 'https://www.vedomosti.ru/rss/news', color: '#607D8B' },
    { id: 'tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', color: '#2E7D32' },
    { id: 'ria', name: 'РИА Новости', url: 'https://ria.ru/export/rss2/index.xml', color: '#FF9800' }
];

// Парсинг одного источника
async function fetchSource(source) {
    try {
        console.log(`📡 Загрузка: ${source.name}`);
        const feed = await parser.parseURL(source.url);
        
        return feed.items.slice(0, 30).map((item, index) => ({
            // 🔥 УНИКАЛЬНЫЙ ID для каждой статьи
            id: `${source.id}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 10)}`,
            sourceId: source.id,
            sourceName: source.name,
            sourceColor: source.color,
            title: item.title || 'Без заголовка',
            summary: (item.contentSnippet || item.summary || '').slice(0, 250) + '...',
            content: item.content || item['content:encoded'] || item.summary || '',
            url: item.link,
            time: formatDate(item.pubDate || item.isoDate),
            timestamp: new Date(item.pubDate || item.isoDate || Date.now()).getTime()
        }));
    } catch (error) {
        console.error(`❌ ${source.name}: ${error.message}`);
        return [];
    }
}

function formatDate(dateString) {
    if (!dateString) return 'Недавно';
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Недавно';
    
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'Только что';
    if (minutes < 60) return `${minutes} мин. назад`;
    if (hours < 24) return `${hours} ч. назад`;
    if (days < 7) return `${days} дн. назад`;
    
    return date.toLocaleDateString('ru-RU');
}

// API endpoint: получить все новости
app.get('/api/news', async (req, res) => {
    const forceRefresh = req.query.refresh === 'true';
    
    // Проверяем кэш
    if (!forceRefresh) {
        const cached = cache.get('all_news');
        if (cached) {
            console.log('📦 Отдано из кэша');
            return res.json({ articles: cached, cached: true });
        }
    }
    
    try {
        console.log('🌐 Загрузка всех источников...');
        
        // Параллельная загрузка
        const promises = SOURCES.map(source => fetchSource(source));
        const results = await Promise.all(promises);
        
        // Собираем все статьи
        let allArticles = results.flat();
        
        // Сортируем по дате
        allArticles.sort((a, b) => b.timestamp - a.timestamp);
        
        // Кэшируем
        cache.set('all_news', allArticles);
        
        console.log(`✅ Загружено ${allArticles.length} статей`);
        res.json({ articles: allArticles, cached: false });
        
    } catch (error) {
        console.error('Ошибка загрузки:', error);
        res.status(500).json({ error: 'Не удалось загрузить новости' });
    }
});

// API endpoint: один источник
app.get('/api/source/:id', async (req, res) => {
    const source = SOURCES.find(s => s.id === req.params.id);
    if (!source) {
        return res.status(404).json({ error: 'Источник не найден' });
    }
    
    const cacheKey = `source_${source.id}`;
    const forceRefresh = req.query.refresh === 'true';
    
    if (!forceRefresh) {
        const cached = cache.get(cacheKey);
        if (cached) {
            return res.json({ articles: cached, cached: true });
        }
    }
    
    try {
        const articles = await fetchSource(source);
        cache.set(cacheKey, articles);
        res.json({ articles, cached: false });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Список источников
app.get('/api/sources', (req, res) => {
    res.json(SOURCES);
});

// Очистка кэша
app.post('/api/clear-cache', (req, res) => {
    cache.flushAll();
    res.json({ message: 'Кэш очищен' });
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`🚀 RSS сервер запущен: http://localhost:${PORT}`);
    console.log(`📡 Доступные источники: ${SOURCES.map(s => s.name).join(', ')}`);
});
