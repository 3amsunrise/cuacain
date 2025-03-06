const cache = new Map();

function debounce(func, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    return new Promise(resolve => {
      timeout = setTimeout(() => resolve(func(...args)), wait);
    });
  };
}

function toTitleCase(str) {
  return str.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

function cleanLocationName(name) {
  return name.replace(/Kabupaten\s+|Kota\s+|Kab.\s+|Adm.\s+/gi, '').trim();
}

function getPrimaryCityName(name) {
  return name.split(' ')[0];
}

async function getApiKey() {
  try {
    const response = await fetch('/api/key', { mode: 'cors' });
    if (!response.ok) throw new Error(`API key fetch failed with status ${response.status}`);
    const data = await response.json();
    if (!data.key) throw new Error('No API key returned');
    return data.key;
  } catch (error) {
    console.error('API Key Fetch Error:', error);
    throw error;
  }
}

async function getCoordinates(query, fullLocationName) {
  if (cache.has(query)) return cache.get(query);
  const OWM_API_KEY = await getApiKey();
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=10&countrycodes=ID`;
  try {
    const response = await fetch(nominatimUrl, {
      headers: { 
        'User-Agent': 'CuacaIn/1.0 (your.email@example.com)',
        'Accept-Language': 'id'
      }
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error('Batas permintaan tercapai. Tunggu sebentar lalu coba lagi.');
      throw new Error('Gagal memuat lokasi.');
    }
    const results = await response.json();
    if (results.length === 0) throw new Error('Lokasi tidak ditemukan.');

    const fullLocationLower = fullLocationName.toLowerCase();

    results.sort((a, b) => (b.importance || 0) - (a.importance || 0));

    const exactMatch = results.find(item => 
      item.display_name.toLowerCase().includes(fullLocationLower) ||
      item.name.toLowerCase() === query.split(',')[0].toLowerCase().trim()
    );

    const selected = exactMatch || results[0];
    const nearby = results
      .filter(item => item.display_name !== selected.display_name)
      .slice(0, 3)
      .map(item => ({ name: item.display_name.split(',')[0].trim(), lat: item.lat, lon: item.lon }));

    const result = {
      selected: { name: selected.display_name, lat: selected.lat, lon: selected.lon },
      nearby
    };
    cache.set(query, result);
    return result;
  } catch (error) {
    console.error('Coordinates Fetch Error:', error);
    throw error;
  }
}

const debouncedGetCoordinates = debounce(getCoordinates, 1000);

async function getWeatherByCoordinates(lat, lon) {
  const OWM_API_KEY = await getApiKey();
  const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric&lang=id`;
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric&lang=id`;
  
  try {
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
  } catch (error) {
    console.error('Weather Fetch Error:', error);
    throw error;
  }
}

class Wilayah {
  constructor() {
    this.apiBase = 'https://www.emsifa.com/api-wilayah-indonesia/api/';
    this.selects = {
      provinsi: document.getElementById('provinsi'),
      kabupaten: document.getElementById('kabupaten'),
    };
    this.cuacaElement = document.getElementById('hasil-cuaca');
    this.provinsiNama = '';
    this.map = null;
    this.marker = null;
    this.weatherLayer = null;
  }

  async init() {
    try {
      if (!this.selects.provinsi || !this.selects.kabupaten || !this.cuacaElement) {
        throw new Error('DOM elements not found');
      }
      await this.loadData('provinces.json', this.selects.provinsi, 'Pilih Provinsi');
      this.setupListeners();
      this.setupDarkMode();
    } catch (error) {
      console.error('Initialization Error:', error);
      this.cuacaElement.innerHTML = `<div class="alert alert-danger">❌ ${error.message}</div>`;
    }
  }

  setupListeners() {
    this.selects.provinsi.addEventListener('change', async () => {
      this.resetSelect(this.selects.kabupaten, 'Pilih Kabupaten/Kota');
      this.resetWeather();
      this.provinsiNama = this.selects.provinsi.selectedOptions[0]?.text.trim() || '';
      if (this.selects.provinsi.value) {
        await this.loadData(
          `regencies/${this.selects.provinsi.value}.json`,
          this.selects.kabupaten,
          'Pilih Kabupaten/Kota'
        );
      }
    });

    this.selects.kabupaten.addEventListener('change', async () => {
      this.resetWeather();
      const kabupatenNama = this.selects.kabupaten.selectedOptions[0]?.text || '';
      if (!kabupatenNama || !this.provinsiNama) {
        this.cuacaElement.innerHTML = `<div class="alert alert-danger">❌ Lokasi tidak valid.</div>`;
        return;
      }
      const cleanedKabupatenNama = cleanLocationName(kabupatenNama);
      const primaryCityName = getPrimaryCityName(cleanedKabupatenNama);
      const fullLocationName = `${kabupatenNama}, ${this.provinsiNama}`;
      const lokasiQuery = `${primaryCityName}, ${this.provinsiNama}, Indonesia`;

      this.cuacaElement.innerHTML = `<div class="loading">Mengambil data cuaca...</div>`;

      try {
        const geoResult = await debouncedGetCoordinates(lokasiQuery, fullLocationName);
        const geoData = geoResult.selected;
        const nearbyCities = geoResult.nearby;
        const dataCuaca = await getWeatherByCoordinates(geoData.lat, geoData.lon);

        const kondisi = toTitleCase(dataCuaca.current.weather[0].description);
        const provinsiOutput = toTitleCase(this.provinsiNama);
        const iconUrl = `https://openweathermap.org/img/wn/${dataCuaca.current.weather[0].icon}@2x.png`;

        const dailyForecasts = [];
        const seenDates = new Set();
        for (const item of dataCuaca.forecast.list) {
          const date = new Date(item.dt * 1000);
          const dateKey = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'numeric', year: 'numeric' });
          if (!seenDates.has(dateKey) && dailyForecasts.length < 7) {
            dailyForecasts.push(item);
            seenDates.add(dateKey);
          }
        }

        const forecastItems = dailyForecasts.map(item => {
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

        let nearbyInfo = '';
        if (nearbyCities.length > 0) {
          const nearbyList = nearbyCities.map(city => `
            <div class="nearby-item">
              <span class="nearby-name">${city.name}</span>
            </div>
          `).join('');
          nearbyInfo = `
            <div class="nearby-card">
              <h6>Kota Terdekat</h6>
              <div class="nearby-container">${nearbyList}</div>
            </div>
          `;
        }

        this.cuacaElement.innerHTML = `
          <div class="weather-card">
            <div class="weather-header">
              <h5>${dataCuaca.current.name}</h5>
              <img src="${iconUrl}" alt="Weather Icon" class="weather-icon">
            </div>
            <div class="weather-details">
              <div class="weather-detail-item">
                <span class="detail-label">Provinsi</span>
                <span class="detail-value">${provinsiOutput}</span>
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
            </div>
            ${nearbyInfo}
            <h6>Prakiraan 7 Hari</h6>
            <div class="forecast-container">${forecastItems}</div>
          </div>
        `;

        await this.updateMap(geoData.lat, geoData.lon); // Ensure map updates asynchronously
      } catch (error) {
        const message = !navigator.onLine ? 'Tidak ada koneksi internet.' : error.message;
        console.error('Load Failed:', error);
        this.cuacaElement.innerHTML = `<div class="alert alert-danger">❌ ${message}</div>`;
      }
    });
  }

  setupDarkMode() {
    const toggle = document.getElementById('dark-mode-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
        toggle.innerHTML = document.body.classList.contains('dark-mode') 
          ? '<i class="bi bi-sun-fill"></i>' 
          : '<i class="bi bi-moon-fill"></i>';
      });
    } else {
      console.error('Dark mode toggle button not found');
    }
  }

  async updateMap(lat, lon) {
    try {
      if (!this.map) {
        this.map = L.map('map').setView([lat, lon], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
        const OWM_API_KEY = await getApiKey();
        this.weatherLayer = L.tileLayer(`https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`, {
          opacity: 0.5
        }).addTo(this.map);
        this.marker = L.marker([lat, lon]).addTo(this.map);
      } else {
        this.map.setView([lat, lon], 10);
        this.marker.setLatLng([lat, lon]);
      }
    } catch (error) {
      console.error('Map Update Error:', error);
      throw error;
    }
  }

  async fetchData(endpoint) {
    try {
      const response = await fetch(`${this.apiBase}${endpoint}`);
      if (!response.ok) throw new Error('Gagal memuat data wilayah.');
      return response.json();
    } catch (error) {
      console.error('Fetch Data Error:', error);
      throw error;
    }
  }

  async loadData(endpoint, selectElement, placeholder) {
    try {
      const data = await this.fetchData(endpoint);
      selectElement.innerHTML = `<option value="" disabled selected>${placeholder}</option>`;
      data.forEach(item => {
        selectElement.innerHTML += `<option value="${item.id}">${item.name}</option>`;
      });
      selectElement.disabled = false;
    } catch (error) {
      console.error('Load Data Error:', error);
    }
  }

  resetSelect(selectElement, placeholder) {
    selectElement.innerHTML = `<option value="" disabled selected>${placeholder}</option>`;
    selectElement.disabled = true;
  }

  resetWeather() {
    this.cuacaElement.innerHTML = '<div class="alert alert-secondary">Silakan pilih Kabupaten/Kota untuk melihat cuaca.</div>';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const wilayah = new Wilayah();
  await wilayah.init();
});