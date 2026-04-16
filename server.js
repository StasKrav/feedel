const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const app = express();
const parser = new Parser({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    },
    maxRedirects: 5
});

const SOURCES_FILE = path.join(__dirname, 'sources.json');
const cache = new NodeCache({ stdTTL: 900 });

app.use(cors());
app.use(express.json());

// ============================================
// Отдача статических файлов (фронтенд)
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// Работа с источниками
// ============================================

function loadSources() {
    try {
        if (fs.existsSync(SOURCES_FILE)) {
            return JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Ошибка чтения sources.json:', error);
    }
    
    return [
        { id: 'habr', name: 'Хабр', url: 'https://habr.com/ru/rss/all/all/?fl=ru', color: '#65C3DF' },
        { id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss.asp', color: '#1A73E8' },
        { id: 'rbc', name: 'РБК', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', color: '#4CAF50' },
        { id: 'lenta', name: 'Lenta.ru', url: 'https://lenta.ru/rss', color: '#9C27B0' },
        { id: 'tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', color: '#2E7D32' },
        { id: 'ria', name: 'РИА Новости', url: 'https://ria.ru/export/rss2/index.xml', color: '#FF9800' }
    ];
}

function saveSources(sources) {
    fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2));
}

let SOURCES = loadSources();

// ============================================
// Извлечение полного текста через Readability
// ============================================

async function fetchFullArticle(url) {
    try {
        console.log(`   📄 Загрузка полного текста: ${url.slice(0, 50)}...`);
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 8000
        });
        
        const html = await response.text();
        const doc = new JSDOM(html, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();
        
        if (article && article.content) {
            return article.content
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
                .trim();
        }
        
        return null;
    } catch (error) {
        console.warn(`   ⚠️ Не удалось извлечь полный текст: ${error.message}`);
        return null;
    }
}

// ============================================
// Форматирование даты
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

// ============================================
// Парсинг источника
// ============================================

async function fetchSource(source) {
    try {
        console.log(`📡 Загрузка: ${source.name}`);
        const feed = await parser.parseURL(source.url);
        
        const items = await Promise.all(feed.items.slice(0, 20).map(async (item, index) => {
            let content = item.content || item['content:encoded'] || item.summary || '';
            
            const isShortContent = content.length < 800 || !content.includes('<p>');
            
            if (isShortContent && item.link) {
                const fullContent = await fetchFullArticle(item.link);
                if (fullContent) {
                    content = fullContent;
                    console.log(`   ✅ Полный текст загружен: ${item.title?.slice(0, 40)}...`);
                }
            }
            
            return {
                id: `${source.id}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
                sourceId: source.id,
                sourceName: source.name,
                sourceColor: source.color,
                title: item.title || 'Без заголовка',
                summary: (item.contentSnippet || item.summary || '').slice(0, 250) + '...',
                content: content,
                url: item.link,
                time: formatDate(item.pubDate || item.isoDate),
                timestamp: new Date(item.pubDate || item.isoDate || Date.now()).getTime()
            };
        }));
        
        return items.filter(item => item.content);
        
    } catch (error) {
        console.error(`❌ ${source.name}: ${error.message}`);
        return [];
    }
}

// ============================================
// API Эндпоинты
// ============================================

app.get('/api/sources', (req, res) => {
    res.json(SOURCES);
});

app.post('/api/sources', async (req, res) => {
    const { name, url, color } = req.body;
    
    if (!name || !url) {
        return res.status(400).json({ error: 'Название и URL обязательны' });
    }
    
    try {
        await parser.parseURL(url);
    } catch (error) {
        return res.status(400).json({ error: 'Не удалось загрузить RSS-ленту' });
    }
    
    const id = name.toLowerCase()
        .replace(/[^a-zа-я0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    
    if (SOURCES.find(s => s.id === id)) {
        return res.status(400).json({ error: 'Источник уже существует' });
    }
    
    const newSource = {
        id,
        name,
        url,
        color: color || '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')
    };
    
    SOURCES.push(newSource);
    saveSources(SOURCES);
    cache.del('all_news');
    
    res.json(newSource);
});

app.delete('/api/sources/:id', (req, res) => {
    const { id } = req.params;
    const index = SOURCES.findIndex(s => s.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Источник не найден' });
    }
    
    SOURCES.splice(index, 1);
    saveSources(SOURCES);
    cache.del('all_news');
    
    res.json({ success: true });
});

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

app.post('/api/clear-cache', (req, res) => {
    cache.flushAll();
    res.json({ message: 'Кэш очищен' });
});

// ============================================
// Главная страница (фронтенд)
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// Запуск сервера
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Feedel запущен: http://localhost:${PORT}`);
    console.log(`📡 Доступные источники: ${SOURCES.map(s => s.name).join(', ')}`);
});
