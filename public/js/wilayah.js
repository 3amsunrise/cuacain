import { BookmarksManager, NotificationManager } from './bookmarks.js';

const cache = new Map();

function toTitleCase(str) {
  return str
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function cleanLocationName(name) {
  return name.replace(/Kabupaten\s+|Kota\s+/gi, '').trim();
}

async function getApiKey() {
  try {
    const response = await fetch('/api/key', { mode: 'cors' });
    if (!response.ok) throw new Error("API key fetch failed with status ${response.status}");
    const data = await response.json();
    if (!data.key) throw new Error('No API key returned');
    return data.key;
  } catch (error) {
    console.error('API Key Fetch Error:', error);
    throw error;
  }
}

async function getCoordinates(query) {
  if (cache.has(query)) return cache.get(query);
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=10&countrycodes=ID`;
  const response = await fetch(nominatimUrl, {
    headers: { 
      'User-Agent': 'CuacaIn/1.0 (https://cuacain.vercel.app/)',
      'Accept-Language': 'id'
    }
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error('Batas permintaan tercapai. Tunggu sebentar lalu coba lagi.');
    throw new Error('Gagal memuat lokasi.');
  }

  const results = await response.json();
  if (results.length === 0) throw new Error('Lokasi tidak ditemukan.');

  results.sort((a, b) => (b.importance || 0) - (a.importance || 0));

  let selected = results[0];
  const isCityOrAdmin = selected.type === 'city' || selected.type === 'administrative' || selected.type === 'town';
  if (!isCityOrAdmin) {
    const cityMatch = results.find(item => item.type === 'city' || item.type === 'administrative');
    if (cityMatch) selected = cityMatch;
  }

  const result = { 
    name: selected.display_name, 
    lat: selected.lat, 
    lon: selected.lon 
  };
  cache.set(query, result);
  return result;
}

async function getWeatherByCoordinates(lat, lon) {
  const OWM_API_KEY = await getApiKey();
  const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric&lang=id`;
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric&lang=id`;
  
  const [currentResponse, forecastResponse] = await Promise.all([
    fetch(currentUrl),
    fetch(forecastUrl)
  ]);

  if (!currentResponse.ok || !forecastResponse.ok) {
    if (currentResponse.status === 429 || forecastResponse.status === 429) {
      throw new Error('Batas API tercapai. Coba lagi nanti.');
    }
    throw new Error('Gagal memuat cuaca.');
  }

  return {
    current: await currentResponse.json(),
    forecast: await forecastResponse.json()
  };
}

class Wilayah {
  constructor() {
    this.apiBase = 'https://alamat.thecloudalert.com/api/';
    this.selects = {
      provinsi: document.getElementById('provinsi'),
      kabupaten: document.getElementById('kabupaten'),
    };
    this.cuacaElement = document.getElementById('hasil-cuaca');
    this.bookmarksManager = new BookmarksManager();
    this.provinsiNama = '';
    this.map = null;
    this.marker = null;
    this.localTimeElement = null;
    this.timeInterval = null;
    this.bookmarkedCities = [];
  }

  async init() {
    if (!this.selects.provinsi || !this.selects.kabupaten || !this.cuacaElement) {
      throw new Error('DOM elements not found');
    }

    this.cuacaElement.innerHTML = '<div class="alert alert-secondary">Silakan pilih Provinsi.</div>';

    // Load provinces
    await this.loadData('provinsi/get/', this.selects.provinsi, 'Pilih Provinsi');

    // Load bookmarks
    try {
      this.bookmarkedCities = await this.bookmarksManager.getBookmarks();
    } catch (error) {
      NotificationManager.show(error.message, 'error');
      this.bookmarkedCities = [];
    }

    this.setupListeners();
    this.setupDarkMode();
  }

  setupListeners() {
    this.selects.provinsi.addEventListener('change', async () => {
      this.resetSelect(this.selects.kabupaten, 'Pilih Kabupaten/Kota');
      this.resetWeather();
      this.provinsiNama = this.selects.provinsi.selectedOptions[0]?.text.trim() || '';
      if (this.selects.provinsi.value) {
        await this.loadData(
          `kabkota/get/?d_provinsi_id=${this.selects.provinsi.value}`,
          this.selects.kabupaten,
          'Pilih Kabupaten/Kota'
        );
        this.cuacaElement.innerHTML = '<div class="alert alert-secondary">Silakan pilih Kabupaten/Kota untuk melihat cuaca.</div>';
      } else {
        this.cuacaElement.innerHTML = '<div class="alert alert-secondary">Silakan pilih Provinsi.</div>';
      }
    });

    this.selects.kabupaten.addEventListener('change', async () => {
      this.resetWeather();
      const kabupatenNama = this.selects.kabupaten.selectedOptions[0]?.text || '';
      if (!kabupatenNama || !this.provinsiNama) {
        this.cuacaElement.innerHTML = `<div class="alert alert-danger">❌ Lokasi tidak valid.</div>`;
        return;
      }

      this.cuacaElement.innerHTML = `<div class="loading">Mengambil data cuaca...</div>`;

      try {
        const { geoData, dataCuaca, localTime, timezoneName, utcTimestamp } = await this.fetchWeatherData(kabupatenNama);
        const forecastItems = this.generateForecastItems(dataCuaca.forecast);
        const isBookmarked = this.bookmarkedCities.some(b => 
          b.city === cleanLocationName(kabupatenNama) && b.province === toTitleCase(this.provinsiNama)
        );

        this.renderWeatherCard(kabupatenNama, dataCuaca, localTime, forecastItems, isBookmarked);
        this.setupWeatherCardListeners(kabupatenNama, toTitleCase(this.provinsiNama));
        this.startTimeUpdate(utcTimestamp, timezoneName);
        await this.updateMap(geoData.lat, geoData.lon);
      } catch (error) {
        const message = !navigator.onLine ? 'Tidak ada koneksi internet.' : error.message;
        this.cuacaElement.innerHTML = `<div class="alert alert-danger">❌ ${message}</div>`;
      }
    });
  }

  async fetchWeatherData(kabupatenNama) {
    const cleanedKabupatenNama = cleanLocationName(kabupatenNama);
    const lokasiQuery = `${cleanedKabupatenNama}, ${this.provinsiNama}, Indonesia`;
    const geoData = await getCoordinates(lokasiQuery);
    const dataCuaca = await getWeatherByCoordinates(geoData.lat, geoData.lon);

    const utcTimestamp = dataCuaca.current.dt;
    const timezoneName = this.getTimezoneName(dataCuaca.current.timezone);
    const localTime = luxon.DateTime.fromSeconds(utcTimestamp, { zone: timezoneName })
      .toFormat('HH:mm:ss');

    return { geoData, dataCuaca, localTime, timezoneName, utcTimestamp };
  }

  generateForecastItems(forecastData) {
    const dailyForecasts = [];
    const seenDates = new Set();
    for (const item of forecastData.list) {
      const date = new Date(item.dt * 1000);
      const dateKey = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'numeric', year: 'numeric' });
      if (!seenDates.has(dateKey) && dailyForecasts.length < 6) {
        dailyForecasts.push(item);
        seenDates.add(dateKey);
      }
    }

    return dailyForecasts.map(item => {
      const date = new Date(item.dt * 1000);
      const dayName = date.toLocaleDateString('id-ID', { weekday: 'long' });
      const dayDate = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
      const forecastKondisi = toTitleCase(item.weather[0].description);
      const forecastIcon = `https://openweathermap.org/img/wn/${item.weather[0].icon}.png`;
      return `
        <div class="forecast-item">
          <p class="forecast-day">${dayName}, ${dayDate}</p>
          <img src="${forecastIcon}" alt="Weather Icon">
          <p class="forecast-condition">${forecastKondisi}</p>
          <p class="forecast-temp">${item.main.temp}°C</p>
        </div>
      `;
    }).join('');
  }

  renderWeatherCard(kabupatenNama, dataCuaca, localTime, forecastItems, isBookmarked) {
    const kondisi = toTitleCase(dataCuaca.current.weather[0].description);
    const iconUrl = `https://openweathermap.org/img/wn/${dataCuaca.current.weather[0].icon}@2x.png`;
    const bookmarkIcon = isBookmarked ? 'bi-bookmark-fill' : 'bi-bookmark';
    const bookmarkTabText = isBookmarked ? 'Tersimpan' : 'Simpan Kota';

    this.cuacaElement.innerHTML = `
      <div class="weather-card">
        <div class="weather-header">
          <img src="${iconUrl}" alt="Weather Icon" class="weather-icon">
          <h5>${toTitleCase(kabupatenNama)}</h5>
          <div class="bookmark-actions">
            <button class="btn-bookmark ${isBookmarked ? 'bookmarked' : ''}" data-city="${cleanLocationName(kabupatenNama)}" data-province="${toTitleCase(this.provinsiNama)}">
              <i class="bi ${bookmarkIcon}"></i>
              <span class="bookmark-tab">${bookmarkTabText}</span>
            </button>
            <button class="btn-bookmarks-list" title="Lihat Bookmarks">
              <i class="bi bi-list-ul"></i>
              <span class="bookmark-tab">Lihat Bookmarks</span>
            </button>
          </div>
        </div>
        <div class="weather-details">
          <div class="weather-detail-item">
            <span class="detail-label">Provinsi</span>
            <span class="detail-value">${toTitleCase(this.provinsiNama)}</span>
          </div>
          <div class="weather-detail-item">
            <span class="detail-label">Cuaca</span>
            <span class="detail-value">${kondisi}</span>
          </div>
          <div class="weather-detail-item">
            <span class="detail-label">Suhu</span>
            <span class="detail-value">${dataCuaca.current.main.temp}°C</span>
          </div>
          <div class="weather-detail-item">
            <span class="detail-label">Kelembapan</span>
            <span class="detail-value">${dataCuaca.current.main.humidity}%</span>
          </div>
          <div class="weather-detail-item">
            <span class="detail-label">Tekanan</span>
            <span class="detail-value">${dataCuaca.current.main.pressure} hPa</span>
          </div>
          <div class="weather-detail-item">
            <span class="detail-label">Angin</span>
            <span class="detail-value">${dataCuaca.current.wind.speed} m/s</span>
          </div>
          <div class="weather-detail-item" id="local-time-container">
            <span class="detail-label">Waktu Lokal</span>
            <span class="detail-value" id="local-time">${localTime}</span>
          </div>
        </div>
        <h6>Prakiraan 6 Hari</h6>
        <div class="forecast-container">${forecastItems}</div>
      </div>
    `;
    this.localTimeElement = document.getElementById('local-time');
  }

  setupWeatherCardListeners(kabupatenNama, province) {
    const bookmarkButton = this.cuacaElement.querySelector('.btn-bookmark');
    bookmarkButton.addEventListener('click', async (e) => {
      e.preventDefault();
      const city = bookmarkButton.dataset.city;
      const bookmark = this.bookmarkedCities.find(b => b.city === city && b.province === province);
      const icon = bookmarkButton.querySelector('i');
      const tab = bookmarkButton.querySelector('.bookmark-tab');

      try {
        if (bookmark) {
          await this.bookmarksManager.deleteBookmark(bookmark.id);
          this.bookmarkedCities = this.bookmarkedCities.filter(b => b.id !== bookmark.id);
          bookmarkButton.classList.remove('bookmarked');
          icon.classList.replace('bi-bookmark-fill', 'bi-bookmark');
          tab.textContent = 'Simpan Kota';
          NotificationManager.show('Bookmark dihapus!', 'error');
        } else {
          const newBookmark = await this.bookmarksManager.addBookmark(city, province);
          this.bookmarkedCities.push(newBookmark);
          bookmarkButton.classList.add('bookmarked');
          icon.classList.replace('bi-bookmark', 'bi-bookmark-fill');
          tab.textContent = 'Tersimpan';
          NotificationManager.show('Bookmark ditambahkan!', 'success');
        }
      } catch (error) {
        NotificationManager.show(error.message, 'error');
      }
    });

    const bookmarksListButton = this.cuacaElement.querySelector('.btn-bookmarks-list');
    bookmarksListButton.addEventListener('click', async (e) => {
      e.preventDefault();
      let bookmarks;
      try {
        bookmarks = await this.bookmarksManager.getBookmarks();
      } catch (error) {
        NotificationManager.show(error.message, 'error');
        bookmarks = this.bookmarkedCities;
      }

      if (bookmarks.length === 0) {
        NotificationManager.show('Belum ada bookmark.', 'info');
        return;
      }

      const bookmarksList = bookmarks
        .map(b => `
          <div class="bookmark-item" data-city="${b.city}" data-province="${b.province}">
            ${b.city}, ${b.province}
          </div>
        `)
        .join('');

      this.cuacaElement.insertAdjacentHTML('beforeend', `
        <div class="bookmarks-modal">
          <div class="bookmarks-content">
            <h5>Daftar Bookmarks</h5>
            <div class="bookmarks-list">${bookmarksList}</div>
            <button class="btn-close-modal">Tutup</button>
          </div>
        </div>
      `);

      const modal = this.cuacaElement.querySelector('.bookmarks-modal');
      modal.querySelectorAll('.bookmark-item').forEach(item => {
        item.addEventListener('click', () => {
          this.selectLocation(item.dataset.city, item.dataset.province);
          modal.remove();
        });
      });

      modal.querySelector('.btn-close-modal').addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    });
  }

  async selectLocation(city, province) {
    const provinsiOption = Array.from(this.selects.provinsi.options).find(opt => opt.text === province);
    if (!provinsiOption) {
      NotificationManager.show('Provinsi tidak ditemukan dalam daftar.', 'error');
      return;
    }

    this.selects.provinsi.value = provinsiOption.value;
    this.provinsiNama = province;
    this.selects.provinsi.dispatchEvent(new Event('change'));

    await this.loadData(
      `kabkota/get/?d_provinsi_id=${provinsiOption.value}`,
      this.selects.kabupaten,
      'Pilih Kabupaten/Kota'
    );

    const kabupatenOption = Array.from(this.selects.kabupaten.options).find(opt => 
      cleanLocationName(opt.text).toLowerCase() === city.toLowerCase()
    );

    if (kabupatenOption) {
      this.selects.kabupaten.value = kabupatenOption.value;
      this.selects.kabupaten.dispatchEvent(new Event('change'));
    } else {
      NotificationManager.show('Kabupaten/Kota tidak ditemukan dalam daftar.', 'error');
    }
  }

  getTimezoneName(timezoneOffsetSeconds) {
    if (timezoneOffsetSeconds === 25200) return 'Asia/Jakarta';
    if (timezoneOffsetSeconds === 28800) return 'Asia/Makassar';
    if (timezoneOffsetSeconds === 32400) return 'Asia/Jayapura';
    return 'UTC';
  }

  updateLocalTime(utcTimestamp, timezoneName) {
    if (!this.localTimeElement) return;
    const currentUtcTime = luxon.DateTime.utc().toSeconds();
    const localTimestamp = utcTimestamp + (currentUtcTime - utcTimestamp);
    this.localTimeElement.textContent = luxon.DateTime.fromSeconds(localTimestamp, { zone: timezoneName })
      .toFormat('HH:mm:ss');
  }

  startTimeUpdate(utcTimestamp, timezoneName) {
    if (this.timeInterval) clearInterval(this.timeInterval);
    this.timeInterval = setInterval(() => this.updateLocalTime(utcTimestamp, timezoneName), 1000);
  }

  setupDarkMode() {
    const toggle = document.getElementById('dark-mode-toggle');
    if (toggle) {
      document.body.classList.add('dark-mode');
      toggle.innerHTML = '<i class="bi bi-sun-fill"></i>';
      toggle.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
        const isDark = document.body.classList.contains('dark-mode');
        toggle.innerHTML = `<i class="bi ${isDark ? 'bi-sun-fill' : 'bi-moon-fill'}"></i>`;
        document.body.style.transition = 'background-color 0.3s, color 0.3s';
      });
    } else {
      console.error('Dark mode toggle button not found');
    }
  }

  async updateMap(lat, lon) {
    const OWM_API_KEY = await getApiKey();
    if (!this.map) {
      this.map = L.map('map').setView([lat, lon], 10);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(this.map);
      L.tileLayer(`https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`, {
        opacity: 0.5
      }).addTo(this.map);
      this.marker = L.marker([lat, lon]).addTo(this.map);
    } else {
      this.map.setView([lat, lon], 10);
      this.marker.setLatLng([lat, lon]);
    }
  }

  async fetchData(endpoint) {
    const response = await fetch(`${this.apiBase}${endpoint}`);
    if (!response.ok) throw new Error('Gagal memuat data wilayah.');
    const data = await response.json();
    if (data.status !== 200 || !data.result) throw new Error('Data wilayah tidak ditemukan dalam respons.');
    return data.result;
  }

  async loadData(endpoint, selectElement, placeholder) {
    const data = await this.fetchData(endpoint);
    selectElement.innerHTML = `<option value="" disabled selected>${placeholder}</option>`;
    data.forEach(item => {
      selectElement.innerHTML += `<option value="${item.id}">${item.text}</option>`;
    });
    selectElement.disabled = false;
  }

  resetSelect(selectElement, placeholder) {
    selectElement.innerHTML = `<option value="" disabled selected>${placeholder}</option>`;
    selectElement.disabled = true;
  }

  resetWeather() {
    this.cuacaElement.innerHTML = '<div class="alert alert-secondary">Silakan pilih Kabupaten/Kota untuk melihat cuaca.</div>';
    if (this.timeInterval) {
      clearInterval(this.timeInterval);
      this.timeInterval = null;
    }
    this.localTimeElement = null;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const wilayah = new Wilayah();
    await wilayah.init();
  } catch (error) {
    document.getElementById('hasil-cuaca').innerHTML = `<div class="alert alert-danger">❌ ${error.message}</div>`;
  }
});