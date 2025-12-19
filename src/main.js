import './style.css';
import * as L from 'leaflet';
import * as turf from '@turf/turf';
import * as XLSX from 'xlsx';

// --- State ---
const state = {
    layers: {
        regions: null,
        provinces: null,
        communes: null
    },
    emergencyData: [], // Array of rows from emergency excel
    mapLayerGroups: {
        regions: L.layerGroup(),
        provinces: L.layerGroup(),
        communes: L.layerGroup(),
        points: L.layerGroup()
    },
    points: [], // Array of { id, lat, lng, properties... }
    processedPoints: [] // Array of { ...original, region, province, commune }
};

// --- Initialization ---
const map = L.map('map').setView([31.7917, -7.0926], 6); // Centered on Morocco

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

// Add layer groups to map
state.mapLayerGroups.regions.addTo(map);
// Provinces and Communes hidden by default to avoid clutter
// state.mapLayerGroups.provinces.addTo(map);
// state.mapLayerGroups.communes.addTo(map);
state.mapLayerGroups.points.addTo(map);

// --- DOM Elements ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const toggleRegions = document.getElementById('toggleRegions');
const toggleProvinces = document.getElementById('toggleProvinces');
const toggleCommunes = document.getElementById('toggleCommunes');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const totalPointsEl = document.getElementById('totalPoints');
const matchedPointsEl = document.getElementById('matchedPoints');
const statsCard = document.getElementById('statsCard');
const exportBtn = document.getElementById('exportBtn');

// --- Load Data ---
async function loadGeoData() {
    updateStatus(true, 'Loading map data...');
    try {
        const [regionsRes, provincesRes, communesRes, emergencyRes] = await Promise.all([
            fetch('/data/regions.json'),
            fetch('/data/provinces.json'),
            fetch('/data/communes.json'),
            fetch('/data/emergency_numbers.xlsx')
        ]);

        state.layers.regions = await regionsRes.json();
        state.layers.provinces = await provincesRes.json();
        state.layers.communes = await communesRes.json();

        // Parse Emergency Excel
        const ab = await emergencyRes.arrayBuffer();
        const wb = XLSX.read(ab, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        state.emergencyData = XLSX.utils.sheet_to_json(sheet);
        console.log('Loaded emergency data:', state.emergencyData.length, 'rows');

        renderGeoJson(state.layers.regions, state.mapLayerGroups.regions, {
            color: '#3b82f6', weight: 2, fillOpacity: 0.1
        });
        renderGeoJson(state.layers.provinces, state.mapLayerGroups.provinces, {
            color: '#10b981', weight: 1, fillOpacity: 0.05
        });
        renderGeoJson(state.layers.communes, state.mapLayerGroups.communes, {
            color: '#ec4899', weight: 0.5, fillOpacity: 0.05
        });

        updateStatus(false);
    } catch (err) {
        console.error(err);
        updateStatus(false);
        alert('Failed to load map data. Please ensuring conversion script ran.');
    }
}

function renderGeoJson(data, group, style) {
    L.geoJSON(data, {
        style: style,
        onEachFeature: (feature, layer) => {
            // Try to find a name property
            const props = feature.properties;
            const name = props.Nom_Region || props.Nom_Provin || props.Nom_Commun || props.Nom_region || props.Nom_provin || props.Nom_commun || props.NAME || 'Unknown';
            layer.bindPopup(name);
        }
    }).addTo(group);
}

// --- File Handling ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) processExcel(file);
});
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processExcel(file);
});

async function processExcel(file) {
    updateStatus(true, 'Reading Excel file...');

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet);

            if (rows.length === 0) {
                throw new Error('Excel file is empty');
            }

            state.points = rows.map((row, idx) => {
                // Find lat/lng columns flexibly
                const keys = Object.keys(row);
                const latKey = keys.find(k => k.toLowerCase().includes('lat'));
                const lngKey = keys.find(k => k.toLowerCase().includes('long') || k.toLowerCase().includes('lng'));

                // Find name/site column
                const nameKey = keys.find(k => k.toLowerCase().includes('site') || k.toLowerCase().includes('name') || k.toLowerCase().includes('code'));

                if (!latKey || !lngKey) return null;

                const id = nameKey ? row[nameKey] : (idx + 1);

                return {
                    id: id,
                    lat: parseFloat(row[latKey]),
                    lng: parseFloat(row[lngKey]),
                    original: row
                };
            }).filter(p => p !== null && !isNaN(p.lat) && !isNaN(p.lng));

            updateStatus(true, `Processing ${state.points.length} points...`);

            // Delay to allow UI to update
            setTimeout(() => analyzePoints(), 100);

        } catch (err) {
            console.error(err);
            alert('Error parsing Excel: ' + err.message);
            updateStatus(false);
        }
    };
    reader.readAsArrayBuffer(file);
}

// --- Analysis Logic ---
function analyzePoints() {
    state.mapLayerGroups.points.clearLayers();
    state.processedPoints = [];

    let matchedCount = 0;

    // Use Turf for Point in Polygon
    // Optimizing: create index or just loop? 
    // Since we have ~1500 communes, looping for each point might be slow if points > 1000.
    // But for user-interface speed it's usually acceptable for < 5000 points.

    state.points.forEach(point => {
        const pt = turf.point([point.lng, point.lat]);

        let commune = 'N/A';
        let province = 'N/A';
        let region = 'N/A';

        // Check Communes (most granular first)
        // Optimization: If found in a commune, we can likely infer province/region if hierarchical, 
        // but the request asks to look them up. 'communes' shapefile usually has parent codes, but let's do geometric check to be sure.

        // Check Regions
        for (const feature of state.layers.regions.features) {
            if (turf.booleanPointInPolygon(pt, feature)) {
                region = feature.properties.Nom_Region || feature.properties.Nom_region || feature.properties.NAME;
                break;
            }
        }

        // Check Provinces
        for (const feature of state.layers.provinces.features) {
            if (turf.booleanPointInPolygon(pt, feature)) {
                province = feature.properties.Nom_Provin || feature.properties.Nom_provin || feature.properties.NAME;
                break;
            }
        }

        // Check Communes
        for (const feature of state.layers.communes.features) {
            if (turf.booleanPointInPolygon(pt, feature)) {
                commune = feature.properties.Nom_Commun || feature.properties.Nom_commun || feature.properties.NAME;
                break;
            }
        }

        // --- Emergency Lookup ---
        // Normalize helper
        const norm = (str) => String(str || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        let emergencyInfo = {
            '141': '', '5757': '', '15': '', '19': '', '112': '', '177': ''
        };

        if (commune !== 'N/A') {
            const match = state.emergencyData.find(row => {
                // Try to match CommuneSS. 
                // Sometimes Province/Region might not match exactly due to spelling, but Commune is usually granular enough.
                // We'll check all 3 for best accuracy, but prioritized.

                const rowCommune = row['Commune SS'] || row['Commune'] || row['COMMUNE'];
                const rowProvince = row['Province'] || row['PROVINCE'];

                // Loose match on commune name
                return norm(rowCommune) === norm(commune);
            });

            if (match) {
                if (match['141']) emergencyInfo['141'] = match['141'];
                if (match['5757']) emergencyInfo['5757'] = match['5757'];
                if (match['15']) emergencyInfo['15'] = match['15'];
                if (match['19']) emergencyInfo['19'] = match['19'];
                if (match['112']) emergencyInfo['112'] = match['112'];
                if (match['177']) emergencyInfo['177'] = match['177'];
            }
        }

        const result = {
            ...point,
            region,
            province,
            commune,
            ...emergencyInfo
        };

        state.processedPoints.push(result);

        // Add to map
        L.circleMarker([point.lat, point.lng], {
            radius: 6,
            fillColor: '#ef4444', // Red dots
            color: '#fff',
            weight: 1,
            opacity: 1,
            fillOpacity: 0.8
        }).bindPopup(`
          <b>${point.id}</b><br>
          Commune: ${commune}<br>
          Province: ${province}<br>
          Region: ${region}
        `).addTo(state.mapLayerGroups.points);

        if (commune !== 'N/A' || province !== 'N/A') matchedCount++;
    });

    renderTable();
    updateStats(state.points.length, matchedCount);
    updateStatus(false);

    // Zoom to points
    if (state.points.length > 0) {
        const bounds = L.latLngBounds(state.points.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    exportBtn.disabled = false;
}

// --- UI Updates ---
function updateStatus(show, text = '') {
    statusBox.style.display = show ? 'flex' : 'none';
    statusText.textContent = text;
}

function updateStats(total, matched) {
    statsCard.style.display = 'block';
    totalPointsEl.textContent = total;
    matchedPointsEl.textContent = matched;
}

function renderTable() {
    resultsTableBody.innerHTML = '';

    // Show first 100 for performance
    const displayPoints = state.processedPoints.slice(0, 500);

    displayPoints.forEach(p => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${p.id}</td>
            <td>${p.lat.toFixed(5)}</td>
            <td>${p.lng.toFixed(5)}</td>
            <td class="${p.commune !== 'N/A' ? '' : 'text-muted'}">${p.commune}</td>
            <td class="${p.province !== 'N/A' ? '' : 'text-muted'}">${p.province}</td>
            <td class="${p.region !== 'N/A' ? '' : 'text-muted'}">${p.region}</td>
            <td>${p['141'] || '-'}</td>
            <td>${p['5757'] || '-'}</td>
            <td>${p['15'] || '-'}</td>
            <td>${p['19'] || '-'}</td>
            <td>${p['112'] || '-'}</td>
            <td>${p['177'] || '-'}</td>
        `;
        resultsTableBody.appendChild(row);
    });
}

// --- Toggles ---
toggleRegions.addEventListener('change', (e) => {
    if (e.target.checked) state.mapLayerGroups.regions.addTo(map);
    else state.mapLayerGroups.regions.remove();
});

toggleProvinces.addEventListener('change', (e) => {
    if (e.target.checked) state.mapLayerGroups.provinces.addTo(map);
    else state.mapLayerGroups.provinces.remove();
});

toggleCommunes.addEventListener('change', (e) => {
    if (e.target.checked) state.mapLayerGroups.communes.addTo(map);
    else state.mapLayerGroups.communes.remove();
});

// --- Export ---
exportBtn.addEventListener('click', () => {
    const dataToExport = state.processedPoints.map(p => ({
        ...p.original,
        'Auto_Commune': p.commune,
        'Auto_Province': p.province,
        'Auto_Region': p.region,
        'Emergency_141': p['141'],
        'Emergency_5757': p['5757'],
        'Emergency_15': p['15'],
        'Emergency_19': p['19'],
        'Emergency_112': p['112'],
        'Emergency_177': p['177']
    }));

    const ws = XLSX.utils.json_to_sheet(dataToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    XLSX.writeFile(wb, "geo_analysis_results.xlsx");
});

// Start
loadGeoData();
