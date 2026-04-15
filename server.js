const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const app = express();
const parser = new Parser({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    },
    maxRedirects: 5
});

// Путь к файлу с источниками
const SOURCES_FILE = path.join(__dirname, 'sources.json');

// Кэш на 15 минут
const cache = new NodeCache({ stdTTL: 900 });

app.use(cors());
app.use(express.json());

// ============================================
// Работа с источниками (чтение/запись в файл)
// ============================================

function loadSources() {
    try {
        if (fs.existsSync(SOURCES_FILE)) {
            const data = fs.readFileSync(SOURCES_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Ошибка чтения sources.json:', error);
    }
    
    // Источники по умолчанию
    return [
        { id: 'habr', name: 'Хабр', url: 'https://habr.com/ru/rss/all/all/?fl=ru', color: '#65C3DF' },
        { id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss.asp', color: '#1A73E8' },
        { id: 'kommersant', name: 'Коммерсантъ', url: 'https://www.kommersant.ru/RSS/main.xml', color: '#E53935' },
        { id: 'rbc', name: 'РБК', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', color: '#4CAF50' },
        { id: 'lenta', name: 'Lenta.ru', url: 'https://lenta.ru/rss', color: '#9C27B0' }
    ];
}

function saveSources(sources) {
    try {
        fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2));
        return true;
    } catch (error) {
        console.error('Ошибка сохранения sources.json:', error);
        return false;
    }
}

let SOURCES = loadSources();

// ============================================
// Парсинг RSS
// ============================================

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

async function fetchSource(source) {
    try {
        console.log(`📡 Загрузка: ${source.name}`);
        const feed = await parser.parseURL(source.url);
        
        return feed.items.slice(0, 30).map((item, index) => ({
            id: `${source.id}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
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

// ============================================
// API Эндпоинты
// ============================================

// Получить все источники
app.get('/api/sources', (req, res) => {
    res.json(SOURCES);
});

// Добавить новый источник
app.post('/api/sources', async (req, res) => {
    const { name, url, color } = req.body;
    
    if (!name || !url) {
        return res.status(400).json({ error: 'Название и URL обязательны' });
    }
    
    // Проверяем, что URL рабочий
    try {
        console.log(`🔍 Проверка нового источника: ${name}`);
        await parser.parseURL(url);
    } catch (error) {
        return res.status(400).json({ error: 'Не удалось загрузить RSS-ленту. Проверьте URL.' });
    }
    
    // Генерируем ID
    const id = name.toLowerCase()
        .replace(/[^a-zа-я0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    
    // Проверяем, нет ли уже такого ID
    if (SOURCES.find(s => s.id === id)) {
        return res.status(400).json({ error: 'Источник с таким названием уже существует' });
    }
    
    const newSource = {
        id,
        name,
        url,
        color: color || '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')
    };
    
    SOURCES.push(newSource);
    
    if (saveSources(SOURCES)) {
        // Очищаем кэш, чтобы новые статьи загрузились
        cache.del('all_news');
        res.json(newSource);
    } else {
        res.status(500).json({ error: 'Не удалось сохранить источник' });
    }
});

// Удалить источник
app.delete('/api/sources/:id', (req, res) => {
    const { id } = req.params;
    const index = SOURCES.findIndex(s => s.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Источник не найден' });
    }
    
    SOURCES.splice(index, 1);
    
    if (saveSources(SOURCES)) {
        cache.del('all_news');
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Не удалось удалить источник' });
    }
});

// Получить все новости
app.get('/api/news', async (req, res) => {
    const forceRefresh = req.query.refresh === 'true';
    
    if (!forceRefresh) {
        const cached = cache.get('all_news');
        if (cached) {
            console.log('📦 Отдано из кэша');
            return res.json({ articles: cached, cached: true });
        }
    }
    
    try {
        console.log('🌐 Загрузка всех источников...');
        
        const promises = SOURCES.map(source => fetchSource(source));
        const results = await Promise.all(promises);
        
        let allArticles = results.flat();
        allArticles.sort((a, b) => b.timestamp - a.timestamp);
        
        cache.set('all_news', allArticles);
        
        console.log(`✅ Загружено ${allArticles.length} статей`);
        res.json({ articles: allArticles, cached: false });
        
    } catch (error) {
        console.error('Ошибка загрузки:', error);
        res.status(500).json({ error: 'Не удалось загрузить новости' });
    }
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
