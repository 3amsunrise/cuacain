let WEATHER_API_KEY = "";
let provinceTranslation = {};
let conditionTranslation = {};

async function loadWeatherAPIKey() {
  const res = await fetch('/api/key');
  if (!res.ok) throw new Error('Gagal memuat API Key');
  const data = await res.json();
  WEATHER_API_KEY = data.key;
}

async function loadProvinceTranslation() {
  const response = await fetch('provinsi.json');
  if (!response.ok) throw new Error('Gagal memuat translasi provinsi');
  provinceTranslation = await response.json();
}

async function loadConditionTranslation() {
  const response = await fetch('cuaca.json');
  if (!response.ok) throw new Error('Gagal memuat translasi kondisi cuaca');
  conditionTranslation = await response.json();
}

function cleanLocationName(name) {
  return name
    .replace(/Kabupaten\s+/gi, '')
    .replace(/Kota\s+/gi, '')
    .replace(/Kab.\s+/gi, '')
    .replace(/Adm.\s+/gi, '')
    .trim();
}

async function getWeather(query) {
  const url = `https://api.weatherapi.com/v1/current.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(query)}&aqi=yes`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 400) {
      const errorData = await response.json();
      if (errorData.error?.message === "No matching location found.") {
        throw new Error('Lokasi tidak ditemukan di WeatherAPI.');
      }
    }
    throw new Error(`Status: ${response.status} - ${response.statusText}`);
  }

  return response.json();
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
    this.provinsiEn = '';
  }

  async init() {
    await this.loadData('provinces.json', this.selects.provinsi, 'Pilih Provinsi');
    this.setupListeners();
  }

  setupListeners() {
    this.selects.provinsi.addEventListener('change', async () => {
      this.resetSelect(this.selects.kabupaten, 'Pilih Kabupaten/Kota');
      this.resetWeather();

      this.provinsiNama = (this.selects.provinsi.selectedOptions[0]?.text || '').trim();
      const provinsiEntry = Object.entries(provinceTranslation).find(
        ([key]) => key === this.provinsiNama
      );
      this.provinsiEn = provinsiEntry ? provinsiEntry[1] : null;

      if (!this.provinsiEn) {
        this.cuacaElement.innerHTML = `<div class="text-danger">❌ Translasi provinsi "${this.provinsiNama}" tidak ditemukan.</div>`;
        return;
      }

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

      const kabupatenNama = cleanLocationName(
        this.selects.kabupaten.selectedOptions[0]?.text || ''
      );

      if (!kabupatenNama || !this.provinsiEn) {
        this.cuacaElement.innerHTML = `<div class="text-danger">❌ Lokasi tidak valid atau provinsi belum dipilih.</div>`;
        return;
      }

      const lokasiQuery = `${kabupatenNama}, ${this.provinsiEn}, Indonesia`;

      this.cuacaElement.innerHTML = `
        <div class="d-flex justify-content-center align-items-center">
          <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <span class="ms-2">Mengambil data cuaca...</span>
        </div>
      `;

      try {
        const dataCuaca = await getWeather(lokasiQuery);

        const country = dataCuaca.location.country;
        const region = dataCuaca.location.region;
        const locationName = dataCuaca.location.name.toLowerCase().trim();
        const targetKabupaten = kabupatenNama.toLowerCase().trim();

        const isSameProvince = region === this.provinsiEn;
        const isSameCountry = country === "Indonesia";
        const isSameLocation = locationName === targetKabupaten;

        const provinsiId = Object.keys(provinceTranslation).find(
          key => provinceTranslation[key] === region
        ) || region;

        let infoLokasiTambahan = '';
        if (!isSameCountry || !isSameProvince) {
          this.cuacaElement.innerHTML = `<div class="text-danger">❌ Data tidak ditemukan.</div>`;
          return;
        } else if (!isSameLocation) {
          infoLokasiTambahan = `
            <div class="text-danger mb-2">
              ❌ Data tidak ditemukan untuk <strong>${kabupatenNama}</strong>.<br>
              🔍 Menampilkan kota terdekat: <strong>${dataCuaca.location.name}</strong> (${region})
            </div>
            <hr>
          `;
        }

        const kondisiAsli = dataCuaca.current.condition.text;
        const kondisi = conditionTranslation[kondisiAsli] || kondisiAsli;

        this.cuacaElement.innerHTML = `
          ${infoLokasiTambahan}
          <h5 class="fw-bold">${dataCuaca.location.name}</h5>
          <p class="mb-1"><strong>Provinsi:</strong> ${provinsiId}, ${dataCuaca.location.country}</p>
          <p class="mb-1"><strong>Waktu Lokal:</strong> ${dataCuaca.location.localtime}</p>
          <p class="mb-1"><strong>Suhu:</strong> ${dataCuaca.current.temp_c}°C</p>
          <p class="mb-1"><strong>Kondisi:</strong> ${kondisi}</p>
          <p class="mb-1"><strong>Kelembapan:</strong> ${dataCuaca.current.humidity}%</p>
          <p class="mb-1"><strong>Angin:</strong> ${dataCuaca.current.wind_kph} km/jam</p>
          <p class="mb-0"><strong>Kualitas Udara (PM2.5):</strong> ${dataCuaca.current.air_quality.pm2_5.toFixed(1)} µg/m³</p>
        `;
      } catch (error) {
        this.cuacaElement.innerHTML = `<div class="text-danger">❌ Gagal mengambil data cuaca. ${error.message}</div>`;
      }
    });
  }

  async fetchData(endpoint) {
    const response = await fetch(`${this.apiBase}${endpoint}`);
    if (!response.ok) throw new Error(`Status: ${response.status} - ${response.statusText}`);
    return response.json();
  }

  async loadData(endpoint, selectElement, placeholder) {
    const data = await this.fetchData(endpoint);
    selectElement.innerHTML = `<option value="" disabled selected>${placeholder}</option>`;
    data.forEach(item => {
      selectElement.innerHTML += `<option value="${item.id}">${item.name.toUpperCase()}</option>`;
    });
    selectElement.disabled = false;
  }

  resetSelect(selectElement, placeholder) {
    selectElement.innerHTML = `<option value="">${placeholder}</option>`;
    selectElement.disabled = true;
  }

  resetWeather() {
    this.cuacaElement.innerHTML = '<div class="text-muted">Silakan pilih Kabupaten/Kota untuk melihat cuaca.</div>';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadWeatherAPIKey();
  await loadProvinceTranslation();
  await loadConditionTranslation();
  const wilayah = new Wilayah();
  await wilayah.init();
});
