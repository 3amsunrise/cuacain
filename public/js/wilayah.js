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

// Membersihkan nama lokasi dari kata seperti "Kabupaten" atau "Kota"
function cleanLocationName(name) {
  return name.replace(/Kabupaten\s+|Kota\s+/gi, '').trim();
}

// Mendapatkan nama kota utama dari string lokasi
function getPrimaryCityName(name) {
  return name.split(' ')[0];
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

// Mendapatkan koordinat lokasi dari Nominatim OpenStreetMap API
async function getCoordinates(query, fullLocationName) {
  if (cache.has(query)) return cache.get(query);
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=10&countrycodes=ID`;
  try {
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

    const fullLocationLower = fullLocationName.toLowerCase();

    results.sort((a, b) => (b.importance || 0) - (a.importance || 0));

    const exactMatch = results.find(item => 
      item.display_name.toLowerCase().includes(fullLocationLower) ||
      item.name.toLowerCase() === query.split(',')[0].toLowerCase().trim()
    );

    const selected = exactMatch || results[0];

    const isCityOrAdmin = selected.type === 'city' || selected.type === 'administrative' || selected.type === 'town';
    if (!isCityOrAdmin) {
      const cityMatch = results.find(item => item.type === 'city' || item.type === 'administrative');
      if (cityMatch) selected = cityMatch;
    }
    const result = {
      selected: { 
        name: selected.display_name, 
        lat: selected.lat, 
        lon: selected.lon 
      },
      nearby: []
    };
    cache.set(query, result);
    return result;
  } catch (error) {
    console.error('Nominatim Fetch Error:', error);
    throw error;
  }
}

// Validasi koordinat dengan OpenWeatherMap Reverse Geocoding
async function validateCoordinatesWithOWM(lat, lon) {
  const OWM_API_KEY = await getApiKey();
  const reverseUrl = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${OWM_API_KEY}`;
  try {
    const response = await fetch(reverseUrl);
    if (!response.ok) {
      console.warn('OWM Reverse Geocoding failed, using Nominatim coordinates as fallback.');
      return { lat, lon };
    }
    const data = await response.json();
    if (data.length === 0) {
      console.warn('No matching location found in OWM, using Nominatim coordinates as fallback.');
      return { lat, lon };
    }
    return { lat: data[0].lat, lon: data[0].lon };
  } catch (error) {
    console.error('OWM Reverse Geocoding Error:', error);
    return { lat, lon };
  }
}

const debouncedGetCoordinates = debounce(getCoordinates, 1000);

// Mendapatkan data cuaca dari OpenWeatherMap API
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
    this.apiBase = 'https://alamat.thecloudalert.com/api/';
    this.selects = {
      provinsi: document.getElementById('provinsi'),
      kabupaten: document.getElementById('kabupaten'),
    };
    this.cuacaElement = document.getElementById('hasil-cuaca');
    this.provinsiNama = '';
    this.map = null; 
    this.marker = null; 
    this.weatherLayer = null; 
    this.localTimeElement = null; 
    this.timeInterval = null; 
  }

  // Inisialisasi aplikasi
  async init() {
    try {
      if (!this.selects.provinsi || !this.selects.kabupaten || !this.cuacaElement) {
        throw new Error('DOM elements not found');
      }
      await this.loadData('provinsi/get/', this.selects.provinsi, 'Pilih Provinsi');
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
          `kabkota/get/?d_provinsi_id=${this.selects.provinsi.value}`,
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
      const fullLocationName = `${cleanedKabupatenNama}, ${this.provinsiNama}`;
      const lokasiQuery = `${primaryCityName}, ${this.provinsiNama}, Indonesia`;

      this.cuacaElement.innerHTML = `<div class="loading">Mengambil data cuaca...</div>`;

      try {
        const geoResult = await debouncedGetCoordinates(lokasiQuery, fullLocationName);
        const geoData = geoResult.selected;
        const dataCuaca = await getWeatherByCoordinates(geoData.lat, geoData.lon);

        const kondisi = toTitleCase(dataCuaca.current.weather[0].description);
        const provinsiOutput = toTitleCase(this.provinsiNama);
        const iconUrl = `https://openweathermap.org/img/wn/${dataCuaca.current.weather[0].icon}@2x.png`;

        const utcTimestamp = dataCuaca.current.dt; 
        const timezoneOffsetSeconds = dataCuaca.current.timezone; 
        const timezoneName = this.getTimezoneName(timezoneOffsetSeconds); 
        const localTime = luxon.DateTime.fromSeconds(utcTimestamp, { zone: timezoneName })
          .toFormat('HH:mm:ss');

        const dailyForecasts = [];
        const seenDates = new Set();
        for (const item of dataCuaca.forecast.list) {
          const date = new Date(item.dt * 1000);
          const dateKey = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'numeric', year: 'numeric' });
          if (!seenDates.has(dateKey) && dailyForecasts.length < 6) {
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

        this.cuacaElement.innerHTML = `
          <div class="weather-card">
            <div class="weather-header">
              <h5>${toTitleCase(kabupatenNama)}</h5> <!-- Menggunakan nama dari dropdown -->
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
        if (this.localTimeElement) {
          this.startTimeUpdate(utcTimestamp, timezoneName);
        }

        await this.updateMap(geoData.lat, geoData.lon);
      } catch (error) {
        const message = !navigator.onLine ? 'Tidak ada koneksi internet.' : error.message;
        console.error('Load Failed:', error);
        this.cuacaElement.innerHTML = `<div class="alert alert-danger">❌ ${message}</div>`;
      }
    });
  }

  getTimezoneName(timezoneOffsetSeconds) {
    if (timezoneOffsetSeconds === 25200) return 'Asia/Jakarta'; 
    if (timezoneOffsetSeconds === 28800) return 'Asia/Makassar';
    if (timezoneOffsetSeconds === 32400) return 'Asia/Jayapura';
    return 'UTC';
  }

  // Memperbarui waktu lokal 
  updateLocalTime(utcTimestamp, timezoneName) {
    if (!this.localTimeElement) return;
    const currentUtcTime = luxon.DateTime.utc().toSeconds();
    const timeDiff = currentUtcTime - utcTimestamp;
    const localTimestamp = utcTimestamp + timeDiff;
    const localTime = luxon.DateTime.fromSeconds(localTimestamp, { zone: timezoneName })
      .toFormat('HH:mm:ss');
    this.localTimeElement.textContent = localTime;
  }

  startTimeUpdate(utcTimestamp, timezoneName) {
    if (this.timeInterval) clearInterval(this.timeInterval);
    this.timeInterval = setInterval(() => this.updateLocalTime(utcTimestamp, timezoneName), 1000);
  }

  // Mengatur mode
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

  // Memperbarui peta berdasarkan koordinat
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

  // Mengambil data dari API wilayah Indonesia
  async fetchData(endpoint) {
    try {
      const response = await fetch(`${this.apiBase}${endpoint}`);
      if (!response.ok) throw new Error('Gagal memuat data wilayah.');
      const data = await response.json();
      if (data.status !== 200 || !data.result) throw new Error('Data wilayah tidak ditemukan dalam respons.');
      return data.result;
    } catch (error) {
      console.error('Fetch Data Error:', error);
      throw error;
    }
  }

  // Memuat data ke dalam elemen select
  async loadData(endpoint, selectElement, placeholder) {
    try {
      const data = await this.fetchData(endpoint);
      selectElement.innerHTML = `<option value="" disabled selected>${placeholder}</option>`;
      data.forEach(item => {
        selectElement.innerHTML += `<option value="${item.id}">${item.text}</option>`;
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

  // Mereset tampilan cuaca
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
  const wilayah = new Wilayah();
  await wilayah.init(); 
});