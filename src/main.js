import './style.css';
import * as L from 'leaflet';
import * as turf from '@turf/turf';
import * as XLSX from 'xlsx';
import 'leaflet-control-geocoder/dist/Control.Geocoder.css';
import 'leaflet-control-geocoder';
import { initCoverageService, getCoverage } from './coverageService';

// --- State ---
const state = {
    layers: {
        regions: null,
        provinces: null,
        communes: null,
        drs: null // aggregated GeoJSON
    },
    drColors: {}, // Map<drName, color>
    drToProvinces: {}, // Map<drName, [provinceNames]>
    regionColors: {}, // Map<regionName, color>
    emergencyData: [], // Array of rows from emergency excel
    emergencyDataMap: new Map(), // Map<normalized_commune, row>
    mapLayerGroups: {
        regions: L.layerGroup(),
        drs: L.layerGroup(),
        provinces: L.layerGroup(),
        communes: L.layerGroup(),
        points: L.layerGroup()
    },
    points: [], // Array of { id, lat, lng, properties... }
    processedPoints: [] // Array of { ...original, region, province, commune }
};

// --- Initialization ---
const map = L.map('map').setView([31.7917, -7.0926], 6); // Centered on Morocco

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
}).addTo(map);

// Add Geocoder
L.Control.geocoder({
    defaultMarkGeocode: false
})
    .on('markgeocode', function (e) {
        const bbox = e.geocode.bbox;
        const poly = L.polygon([
            bbox.getSouthEast(),
            bbox.getNorthEast(),
            bbox.getNorthWest(),
            bbox.getSouthWest()
        ]).addTo(map);
        map.fitBounds(poly.getBounds());
    })
    .addTo(map);

// Add layer groups to map
state.mapLayerGroups.regions.addTo(map);
state.mapLayerGroups.drs.addTo(map);
// Provinces and Communes hidden by default to avoid clutter, but groups must be strictly added if we want them togglable
state.mapLayerGroups.provinces.addTo(map);
state.mapLayerGroups.communes.addTo(map);
state.mapLayerGroups.points.addTo(map);

// --- DOM Elements ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const toggleRegions = document.getElementById('toggleRegions');
const toggleDRs = document.getElementById('toggleDRs');
const toggleProvinces = document.getElementById('toggleProvinces');
const toggleCommunes = document.getElementById('toggleCommunes');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const totalPointsEl = document.getElementById('totalPoints');
const drLegend = document.getElementById('drLegend');
const matchedPointsEl = document.getElementById('matchedPoints');
const emptySSPointsEl = document.getElementById('emptySSPoints');
const filtersCard = document.getElementById('filtersCard');
const filterEmptySS = document.getElementById('filterEmptySS');
// const statsCard = document.getElementById('statsCard');
const exportBtn = document.getElementById('exportBtn');
const exportHierarchyBtn = document.getElementById('exportHierarchyBtn');
const siteSearchInput = document.getElementById('siteSearchInput');
const siteSearchBtn = document.getElementById('siteSearchBtn');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const sidebar = document.querySelector('.sidebar');
const manualSiteName = document.getElementById('manualSiteName');
const manualLat = document.getElementById('manualLat');
const manualLng = document.getElementById('manualLng');
const addSiteBtn = document.getElementById('addSiteBtn');


// --- Load Data ---
async function loadGeoData() {
    updateStatus(true, 'Loading map data...');
    try {
        const timestamp = new Date().getTime();
        const [regionsRes, provincesRes, communesRes, emergencyRes, drMappingRes, drsRes] = await Promise.all([
            fetch(`/data/regions.json?v=${timestamp}`),
            fetch(`/data/provinces.json?v=${timestamp}`),
            fetch(`/data/communes.json?v=${timestamp}`),
            fetch(`/data/emergency_numbers.xlsx?v=${timestamp}`),
            fetch(`/data/province_to_dr.xlsx?v=${timestamp}`),
            fetch(`/data/drs.json?v=${timestamp}`),
            initCoverageService()
        ]);

        state.layers.regions = await regionsRes.json();
        state.layers.provinces = await provincesRes.json();
        state.layers.communes = await communesRes.json();

        // Parse Emergency Excel & Build Map
        const ab = await emergencyRes.arrayBuffer();
        const wb = XLSX.read(ab, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        state.emergencyData = XLSX.utils.sheet_to_json(sheet);

        // Build Index
        state.emergencyDataMap.clear();
        const norm = (str) => String(str || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        state.emergencyData.forEach(row => {
            const rowCommune = row['Commune SS'] || row['Commune'] || row['COMMUNE'];
            // const rowProvince = row['Province'] || row['PROVINCE'];
            if (rowCommune) {
                state.emergencyDataMap.set(norm(rowCommune), row);
            }
        });

        console.log('Loaded emergency data:', state.emergencyData.length, 'rows. Indexed:', state.emergencyDataMap.size);

        // Pre-calc BBoxes for fast spatial lookup
        const calcBBoxes = (fc) => {
            fc.features.forEach(f => {
                f.bbox = turf.bbox(f);
            });
        };
        calcBBoxes(state.layers.regions);
        calcBBoxes(state.layers.provinces);
        calcBBoxes(state.layers.communes);


        // --- Region Coloring ---
        // distinct colors for 12 regions
        const distinctColors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD', '#D4A5A5',
            '#9B59B6', '#3498DB', '#E67E22', '#2ECC71', '#F1C40F', '#E74C3C'
        ];

        // Create mapping: RegionName -> Color
        // stored in state for legend usage
        const regionColorMap = new Map();

        state.layers.regions.features.forEach((feature, index) => {
            const props = feature.properties;
            const name = props.Nom_Region || props.Nom_region || props.NAME || 'Region ' + (index + 1);
            if (!regionColorMap.has(name)) {
                const color = distinctColors[regionColorMap.size % distinctColors.length];
                regionColorMap.set(name, color);
                state.regionColors[name] = color;
            }
        });

        // Remove old Leaflet Legend if present
        // (No persistent ref kept, but we are using custom #drLegend now)





        // --- DR Aggregation Logic (Optimized) ---
        try {
            // Load pre-generated DRs
            state.layers.drs = await drsRes.json();

            // Load Mapping for Filtering
            const drAb = await drMappingRes.arrayBuffer();
            const drWb = XLSX.read(drAb, { type: 'array' });
            const drSheet = drWb.Sheets[drWb.SheetNames[0]];
            const drRows = XLSX.utils.sheet_to_json(drSheet);

            const drMap = new Map();
            drRows.forEach(row => {
                const drName = row['DR'];
                const provinceName = row['Province'];
                if (drName && provinceName) {
                    if (!drMap.has(drName)) drMap.set(drName, []);
                    drMap.get(drName).push(provinceName);
                }
            });

            // Store in state for UI filtering
            drMap.forEach((v, k) => state.drToProvinces[k] = v);

            // Set all DRs to visible by default
            if (state.drToProvinces) {
                Object.keys(state.drToProvinces).forEach(drName => {
                    hierarchy.visible.drs.add(drName);
                });
                hierarchy.visible.drs.add('DRR'); // Exceptions target
            }

            // Assign Colors to DRs
            const palette = [
                '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD', '#D4A5A5',
                '#9B59B6', '#3498DB', '#E67E22', '#2ECC71', '#F1C40F', '#E74C3C'
            ];

            state.layers.drs.features.forEach((f, i) => {
                const name = f.properties.NAME;
                state.drColors[name] = palette[i % palette.length];
            });

            // Update DR Layer Style function to use assigned colors
            state.mapLayerGroups.drs.clearLayers();
            L.geoJSON(state.layers.drs, {
                style: (feature) => ({
                    color: state.drColors[feature.properties.NAME] || '#8b5cf6',
                    weight: 2,
                    fillOpacity: 0.4,
                    dashArray: '5, 5'
                }),
                onEachFeature: (feature, layer) => {
                    layer.bindPopup(`<b>${feature.properties.NAME}</b>`);
                }
            }).addTo(state.mapLayerGroups.drs);

            console.log(`Loaded ${state.layers.drs.features.length} DR regions.`);

        } catch (e) {
            console.error("Error processing DR mapping:", e);
        }



        updateStatus(false);

        // Initialize Visibility Sets
        // Regions: All visible by default
        state.layers.regions.features.forEach(f => {
            const name = f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME;
            if (name) hierarchy.visible.regions.add(name);
        });

        // DRs: All visible by default (handled in DR logic, but good to confirm)
        // Provinces/Communes: Hidden by default (sets empty)

        // Initial Hierarchy Render
        renderRegions();
        renderDRs();
        renderProvinces();
        renderCommunes();

        // Initial Map Layer Render
        updateMapVisibility('region');
        updateMapVisibility('dr');
        updateMapVisibility('province');
        updateMapVisibility('commune');

        // updateLegend(); // Handled by toggles? No, remove updateLegend call since toggles are removed or different
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

                const parseCoord = (val) => {
                    if (typeof val === 'number') return val;
                    if (typeof val === 'string') {
                        return parseFloat(val.replace(',', '.'));
                    }
                    return parseFloat(val);
                };

                return {
                    id: id,
                    lat: parseCoord(row[latKey]),
                    lng: parseCoord(row[lngKey]),
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



// --- Helpers ---
function createRow(p) {
    const row = document.createElement('tr');
    row.id = `row-${p.id}`;
    row.innerHTML = `
        <td>${p.id}</td>
        <td>${p.lat.toFixed(5)}</td>
        <td>${p.lng.toFixed(5)}</td>
        <td class="${p.commune !== 'N/A' ? '' : 'text-muted'}">${p.commune}</td>
        <td class="${p.province !== 'N/A' ? '' : 'text-muted'}">${p.province}</td>
        <td class="${p.region !== 'N/A' ? '' : 'text-muted'}">${p.region}</td>
        <td class="${p.dr !== 'N/A' ? '' : 'text-muted'}">${p.dr}</td>
        <td>${p['141'] || '-'}</td>
        <td>${p['5757'] || '-'}</td>
        <td>${p['15'] || '-'}</td>
        <td>${p['19'] || '-'}</td>
        <td>${p['112'] || '-'}</td>
        <td>${p['177'] || '-'}</td>
    `;
    return row;
}

function highlightTableRow(id) {
    let row = document.getElementById(`row-${id}`);

    // If row not found (e.g. outside of 500 limit), try to find point and add it
    if (!row) {
        const point = state.processedPoints.find(p => p.id == id); // Loose equality for string/number match
        if (point) {
            row = createRow(point);
            resultsTableBody.appendChild(row);
        }
    }

    if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('highlight-row');
        setTimeout(() => row.classList.remove('highlight-row'), 3000);
    } else {
        console.log("Row not found for id:", id);
    }
}

// --- Analysis Logic ---
function analyzePoints() {
    state.mapLayerGroups.points.clearLayers();
    state.processedPoints = [];

    // Reset stats
    updateStats(state.points.length, 0, 0);

    const CHUNK_SIZE = 200;
    let currentIndex = 0;
    let matchedCount = 0;
    let emptySSCount = 0;
    let layerBuffer = []; // Buffer markers to add to map in batches

    // Disable export during processing
    exportBtn.disabled = true;

    const norm = (str) => String(str || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    async function processChunk() {
        const end = Math.min(currentIndex + CHUNK_SIZE, state.points.length);

        for (let i = currentIndex; i < end; i++) {
            const point = state.points[i];
            const pt = turf.point([point.lng, point.lat]); // lng, lat

            let commune = 'N/A';
            let province = 'N/A';
            let region = 'N/A';
            let dr = 'N/A';

            // Helper for optimized spatial check
            const findInLayer = (layer) => {
                for (const feature of layer.features) {
                    // Fast rejection using BBox
                    // BBox format: [minX, minY, maxX, maxY]
                    // Point format: [lng, lat]
                    if (feature.bbox) {
                        const [minX, minY, maxX, maxY] = feature.bbox;
                        if (point.lng < minX || point.lng > maxX || point.lat < minY || point.lat > maxY) {
                            continue;
                        }
                    } else {
                        // Fallback calc if missing? Should be there.
                    }

                    if (turf.booleanPointInPolygon(pt, feature)) {
                        return feature.properties.Nom_Region || feature.properties.Nom_Provin || feature.properties.Nom_Commun || feature.properties.NAME || 'N/A';
                    }
                }
                return 'N/A';
            };

            // Order matters? Regions -> Provinces -> Communes
            // Actually independent checks as per original code.
            region = findInLayer(state.layers.regions);
            dr = findInLayer(state.layers.drs);
            province = findInLayer(state.layers.provinces);
            commune = findInLayer(state.layers.communes);

            // --- Emergency Lookup (Map O(1)) ---
            let emergencyInfo = {
                '141': '', '5757': '', '15': '', '19': '', '112': '', '177': ''
            };

            if (commune !== 'N/A') {
                const match = state.emergencyDataMap.get(norm(commune));
                if (match) {
                    if (match['141']) emergencyInfo['141'] = match['141'];
                    if (match['5757']) emergencyInfo['5757'] = match['5757'];
                    if (match['15']) emergencyInfo['15'] = match['15'];
                    if (match['19']) emergencyInfo['19'] = match['19'];
                    if (match['112']) emergencyInfo['112'] = match['112'];
                    if (match['177']) emergencyInfo['177'] = match['177'];
                }
            }

            // --- Coverage Lookup ---
            // const coverage = await getCoverage(point.lat, point.lng); // optimization: removed

            const result = {
                ...point,
                region, dr, province, commune, ...emergencyInfo
            };

            state.processedPoints.push(result);

            if (commune !== 'N/A' || province !== 'N/A') matchedCount++;

            // Calculate Empty SS: All emergency numbers are empty
            const hasSSData = emergencyInfo['141'] || emergencyInfo['5757'] || emergencyInfo['15'] || emergencyInfo['19'] || emergencyInfo['112'] || emergencyInfo['177'];
            if (!hasSSData) {
                emptySSCount++;
                result._isEmptySS = true; // Use result obj
            } else {
                result._isEmptySS = false;
            }

            // Marker
            // Find which keys have data (DEBUG)
            const foundKeys = Object.keys(emergencyInfo).filter(k => emergencyInfo[k]).join(', ');

            const marker = L.circleMarker([point.lat, point.lng], {
                radius: 6,
                fillColor: (!hasSSData) ? '#f97316' : '#ef4444',
                color: '#fff',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            }).bindPopup(`
              <b>${point.id}</b><br>
              Commune: ${commune}<br>
              Province: ${province}<br>
              Region: ${region}<br>
              DR: ${dr}<br>
              SS Data Found: ${foundKeys || 'None'}
            `);

            // Add click listener
            marker.on('click', () => {
                highlightTableRow(point.id);
            });

            layerBuffer.push(marker);
        }

        // Add buffer to map
        // optimization: addLayer is fast, but adding thousands is slow. LayerGroup handle it ok?
        // Maybe add chunk to a temp group then merge?
        // Just adding directly is fine for 200 items.
        layerBuffer.forEach(m => m.addTo(state.mapLayerGroups.points));
        layerBuffer = [];

        currentIndex = end;
        updateStatus(true, `Processed ${currentIndex} / ${state.points.length} points...`);
        updateStats(state.points.length, matchedCount, emptySSCount);

        if (currentIndex < state.points.length) {
            setTimeout(processChunk, 0); // Next chunk
        } else {
            // Done
            finishAnalysis(matchedCount, emptySSCount);
        }
    }

    // Start
    setTimeout(processChunk, 0);
}

function finishAnalysis(matchedCount, emptySSCount) {
    renderTable();
    updateStatus(false);
    filtersCard.style.display = 'block';

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

function updateStats(total, matched, emptySS) {
    // statsCard.style.display = 'block';
    totalPointsEl.textContent = total;
    matchedPointsEl.textContent = matched;
    emptySSPointsEl.textContent = emptySS;
}

function updateLegend() {
    drLegend.innerHTML = '';
    let hasContent = false;

    if (toggleRegions.checked) {
        hasContent = true;
        const section = document.createElement('div');
        section.innerHTML = '<h4>Regions</h4>';
        drLegend.appendChild(section);

        Object.keys(state.regionColors).forEach(name => {
            const color = state.regionColors[name];
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `<div class="legend-color" style="background: ${color}"></div><span>${name}</span>`;
            drLegend.appendChild(item);
        });
    }

    if (toggleDRs.checked) {
        if (hasContent) {
            const separator = document.createElement('hr');
            separator.style.margin = '10px 0';
            separator.style.border = '0';
            separator.style.borderTop = '1px solid rgba(255,255,255,0.1)';
            drLegend.appendChild(separator);
        }
        hasContent = true;
        const section = document.createElement('div');
        section.innerHTML = '<h4>Directions Régionales</h4>';
        drLegend.appendChild(section);

        Object.keys(state.drColors).forEach(name => {
            const color = state.drColors[name];
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `<div class="legend-color" style="background: ${color}"></div><span>${name}</span>`;
            drLegend.appendChild(item);
        });
    }

    drLegend.style.display = hasContent ? 'block' : 'none';
}

function renderTable() {
    resultsTableBody.innerHTML = '';
    state.mapLayerGroups.points.clearLayers(); // Re-render markers based on filter

    const showOnlyEmptySS = filterEmptySS.checked;

    const filteredPoints = state.processedPoints.filter(p => {
        if (showOnlyEmptySS) return p._isEmptySS;
        return true;
    });

    // Re-add markers
    filteredPoints.forEach(p => {
        L.circleMarker([p.lat, p.lng], {
            radius: 6,
            fillColor: p._isEmptySS ? '#f97316' : '#ef4444', // Orange for missing SS, Red for others
            color: '#fff',
            weight: 1,
            opacity: 1,
            fillOpacity: 0.8
        }).bindPopup(`
          <b>${p.id}</b><br>
          Commune: ${p.commune}<br>
          Province: ${p.province}<br>
          Region: ${p.region}<br>
          ${p._isEmptySS ? '<b style="color:orange">Missing SS Data</b>' : ''}
        `).addTo(state.mapLayerGroups.points).on('click', () => {
            highlightTableRow(p.id);
        });
    });

    // Show first 500 of filtered list
    const displayPoints = filteredPoints.slice(0, 500);

    displayPoints.forEach(p => {
        const row = createRow(p);
        resultsTableBody.appendChild(row);
    });
}

filterEmptySS.addEventListener('change', () => {
    renderTable();
});

// --- Hierarchy State ---
const hierarchy = {
    selectedRegion: null,
    selectedProvince: null,
    selectedDR: null,
    visible: {
        regions: new Set(), // Set of names
        provinces: new Set(),
        communes: new Set(),
        drs: new Set()
    }
};

// --- DOM Elements for Hierarchy ---
const regionList = document.getElementById('regionList');
const provinceList = document.getElementById('provinceList');
const communeList = document.getElementById('communeList');
const drList = document.getElementById('drList');
const resetRegionBtn = document.getElementById('resetRegionBtn');

// --- Hierarchy Render Logic ---

function createListItem(name, type, isSelected, isVisible) {
    const div = document.createElement('div');
    div.className = `list-item ${isSelected ? 'selected' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isVisible;
    checkbox.onclick = (e) => {
        e.stopPropagation();
        toggleVisibility(type, name, checkbox.checked);
    };

    const label = document.createElement('label');
    label.textContent = name;

    div.appendChild(checkbox);
    div.appendChild(label);

    div.onclick = () => selectItem(type, name);

    return div;
}

function renderRegions() {
    regionList.innerHTML = '';
    const regions = state.layers.regions.features.map(f => f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME).sort();

    regions.forEach(name => {
        const isSelected = hierarchy.selectedRegion === name;
        const isVisible = hierarchy.visible.regions.has(name);
        regionList.appendChild(createListItem(name, 'region', isSelected, isVisible));
    });
}

function renderDRs() {
    drList.innerHTML = '';
    const drs = state.layers.drs.features.map(f => f.properties.NAME).sort();

    drs.forEach(name => {
        const isSelected = hierarchy.selectedDR === name;
        const isVisible = hierarchy.visible.drs.has(name);
        drList.appendChild(createListItem(name, 'dr', isSelected, isVisible));
    });
}

function renderProvinces() {
    provinceList.innerHTML = '';
    let provinces = state.layers.provinces.features;

    // Filter by Region
    if (hierarchy.selectedRegion) {
        // Find Region Code
        const rFeat = state.layers.regions.features.find(f => (f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME) === hierarchy.selectedRegion);
        if (rFeat) {
            const code = rFeat.properties.Code_Regio;
            provinces = provinces.filter(p => p.properties.Code_Regio === code);
        }
    }
    // Filter by DR
    else if (hierarchy.selectedDR) {
        const allowedProvinces = state.drToProvinces[hierarchy.selectedDR];
        if (allowedProvinces) {
            const normalize = (str) => String(str).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const allowedSet = new Set(allowedProvinces.map(p => normalize(p)));

            provinces = provinces.filter(p => {
                const pName = p.properties.Nom_Provin || p.properties.Nom_provin || p.properties.NAME;
                return allowedSet.has(normalize(pName));
            });
        }
    }

    const provinceNames = provinces.map(f => f.properties.Nom_Provin || f.properties.Nom_provin || f.properties.NAME).sort();
    const uniqueNames = [...new Set(provinceNames)];

    uniqueNames.forEach(name => {
        const isSelected = hierarchy.selectedProvince === name;
        const isVisible = hierarchy.visible.provinces.has(name);
        provinceList.appendChild(createListItem(name, 'province', isSelected, isVisible));
    });
}

function renderCommunes() {
    communeList.innerHTML = '';
    let communes = state.layers.communes.features;

    if (hierarchy.selectedProvince) {
        const pFeat = state.layers.provinces.features.find(f => (f.properties.Nom_Provin || f.properties.Nom_provin || f.properties.NAME) === hierarchy.selectedProvince);
        if (pFeat) {
            const code = pFeat.properties.Code_Provi;
            communes = communes.filter(c => c.properties.Code_Provi === code);
        }
    } else {
        // If no province selected, maybe show nothing? or all (too many!)?
        // Show all but maybe limit?
        // Let's show empty text if no province selected to save DOM
        communeList.innerHTML = '<div style="padding:0.5rem; color:#aaa">Select a Province</div>';
        return;
    }

    const communeNames = communes.map(f => f.properties.Nom_Commun || f.properties.Nom_commun || f.properties.NAME).sort();

    communeNames.forEach(name => {
        const isVisible = hierarchy.visible.communes.has(name);
        communeList.appendChild(createListItem(name, 'commune', false, isVisible));
    });
}

// --- Interaction Logic ---
function selectItem(type, name) {
    if (type === 'region') {
        if (hierarchy.selectedRegion === name) {
            hierarchy.selectedRegion = null;
        } else {
            hierarchy.selectedRegion = name;
        }
        hierarchy.selectedProvince = null;
        hierarchy.selectedDR = null;

        renderRegions();
        renderDRs();
        renderProvinces();
        renderCommunes();

        if (hierarchy.selectedRegion) {
            const feat = state.layers.regions.features.find(f => (f.properties.Nom_Region || f.properties.Nom_region || f.properties.NAME) === name);
            if (feat) {
                const poly = L.geoJSON(feat);
                map.fitBounds(poly.getBounds());
            }
        }

    } else if (type === 'province') {
        if (hierarchy.selectedProvince === name) {
            hierarchy.selectedProvince = null;
        } else {
            hierarchy.selectedProvince = name;
        }

        renderProvinces();
        renderCommunes();

        if (hierarchy.selectedProvince) {
            const feat = state.layers.provinces.features.find(f => (f.properties.Nom_Provin || f.properties.Nom_provin || f.properties.NAME) === name);
            if (feat) {
                const poly = L.geoJSON(feat);
                map.fitBounds(poly.getBounds());
            }
        }

    } else if (type === 'dr') {
        if (hierarchy.selectedDR === name) {
            hierarchy.selectedDR = null;
        } else {
            hierarchy.selectedDR = name;
        }
        hierarchy.selectedRegion = null;
        hierarchy.selectedProvince = null;

        renderDRs();
        renderRegions();
        renderProvinces();
        renderCommunes();

        if (hierarchy.selectedDR) {
            const feat = state.layers.drs.features.find(f => f.properties.NAME === name);
            if (feat) {
                const poly = L.geoJSON(feat);
                map.fitBounds(poly.getBounds());
            }
        }
    }
}

function toggleVisibility(type, name, isChecked) {
    const set = hierarchy.visible[type + 's']; // plural key
    if (isChecked) set.add(name);
    else set.delete(name);

    // Update Map
    updateMapVisibility(type);
}

function updateMapVisibility(type) {
    const group = state.mapLayerGroups[type + 's'];
    group.clearLayers();

    const set = hierarchy.visible[type + 's'];
    const layerData = state.layers[type + 's'];

    if (!layerData) return;

    const featuresToShow = layerData.features.filter(f => {
        const n = f.properties.Nom_Region || f.properties.Nom_Provin || f.properties.Nom_Commun || f.properties.NAME || f.properties.Nom_region || f.properties.Nom_provin || f.properties.Nom_commun;
        return set.has(n);
    });

    // Style
    let style = { color: '#3388ff', weight: 1 };
    if (type === 'region') style = (f) => ({ color: state.regionColors[f.properties.Nom_Region || f.properties.NAME] || '#3388ff', weight: 2, fillOpacity: 0.4 });
    if (type === 'dr') style = (f) => ({ color: state.drColors[f.properties.NAME] || '#8b5cf6', weight: 2, fillOpacity: 0.4, dashArray: '5, 5' });
    if (type === 'province') style = { color: '#10b981', weight: 1, fillOpacity: 0.1 };
    if (type === 'commune') style = { color: '#ec4899', weight: 0.5, fillOpacity: 0.1 };

    if (featuresToShow.length > 0) { // Optimization
        L.geoJSON({ type: "FeatureCollection", features: featuresToShow }, {
            style: style,
            onEachFeature: (feature, layer) => {
                const n = feature.properties.Nom_Region || feature.properties.Nom_Provin || feature.properties.Nom_Commun || feature.properties.NAME;
                layer.bindPopup(n);
            }
        }).addTo(group);
    }
}

resetRegionBtn.addEventListener('click', () => {
    hierarchy.selectedRegion = null;
    hierarchy.selectedProvince = null;
    hierarchy.selectedDR = null;
    renderRegions();
    renderProvinces();
    renderCommunes();
    map.setView([31.7917, -7.0926], 6);
});

// --- Export ---
exportBtn.addEventListener('click', () => {
    const dataToExport = state.processedPoints.map(p => ({
        ...p.original,
        'Auto_Commune': p.commune,
        'Auto_Province': p.province,
        'Auto_Region': p.region,
        'Coverage_2G': p['2G'],
        'Coverage_3G': p['3G'],
        'Coverage_4G': p['4G'],
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

exportHierarchyBtn.addEventListener('click', () => {
    if (!state.layers.regions || !state.layers.provinces || !state.layers.communes) {
        alert("Map data not loaded yet.");
        return;
    }

    const rows = [];
    const regions = state.layers.regions.features;
    const provinces = state.layers.provinces.features;
    const communes = state.layers.communes.features;

    regions.forEach(regionFeat => {
        const rProps = regionFeat.properties;
        const rName = rProps.Nom_Region || rProps.Nom_region || rProps.NAME;
        const rCode = rProps.Code_Regio;

        // Find Provinces
        const regionProvinces = provinces.filter(p => p.properties.Code_Regio === rCode);

        if (regionProvinces.length === 0) {
            rows.push({ Region: rName, Province: '', Commune: '' });
        } else {
            regionProvinces.forEach(provFeat => {
                const pProps = provFeat.properties;
                const pName = pProps.Nom_Provin || pProps.Nom_provin || pProps.NAME;
                const pCode = pProps.Code_Provi;

                // Find Communes
                const provCommunes = communes.filter(c => c.properties.Code_Provi === pCode);

                if (provCommunes.length === 0) {
                    rows.push({ Region: rName, Province: pName, Commune: '' });
                } else {
                    provCommunes.forEach(commFeat => {
                        const cProps = commFeat.properties;
                        const cName = cProps.Nom_Commun || cProps.Nom_commun || cProps.NAME;
                        rows.push({ Region: rName, Province: pName, Commune: cName });
                    });
                }
            });
        }
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Hierarchy");
    XLSX.writeFile(wb, "regions_provinces_communes.xlsx");
});

// --- Site Search ---
siteSearchBtn.addEventListener('click', () => {
    const query = siteSearchInput.value.trim().toLowerCase();
    if (!query) return;

    // Search in processedPoints
    const foundPoint = state.processedPoints.find(p =>
        String(p.id).toLowerCase() === query
    );

    if (foundPoint) {
        // Zoom Map
        map.flyTo([foundPoint.lat, foundPoint.lng], 15);

        // Open Popup
        // We need to find the marker. Since markers are in a LayerGroup, 
        // we can iterate or keep a ref? Iterating is fine for now < 10k points.
        // Actually, just creating a temp popup is easier if we don't have direct ref.
        L.popup()
            .setLatLng([foundPoint.lat, foundPoint.lng])
            .setContent(`<b>${foundPoint.id}</b><br>Found via Search`)
            .openOn(map);

        // Highlight Table Row
        highlightTableRow(foundPoint.id);
    } else {
        alert("Site not found!");
    }
});

// --- Sidebar Toggle ---
toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');

    // Resize map after transition
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
});

// --- Manual Add ---
addSiteBtn.addEventListener('click', () => {
    const name = manualSiteName.value.trim();
    const lat = parseFloat(manualLat.value);
    const lng = parseFloat(manualLng.value);

    if (!name || isNaN(lat) || isNaN(lng)) {
        alert("Please enter valid Name, Latitude, and Longitude.");
        return;
    }

    const newPoint = {
        id: name,
        lat: lat,
        lng: lng,
        original: { 'Site Name': name, 'Latitude': lat, 'Longitude': lng } // Mock original data
    };

    state.points.push(newPoint);
    updateStatus(true, "Processing new site...");

    // Clear inputs
    manualSiteName.value = '';
    manualLat.value = '';
    manualLng.value = '';

    // Re-run analysis to categorize the new point
    // Optimization: Could just process this one point, but analyzePoints handles everything.
    // Given < 10k points, full re-run is acceptable for safety and simplicity.
    setTimeout(() => {
        analyzePoints();

        // After analysis, zoom to it
        setTimeout(() => {
            // Find it in processed to get correct ref? 
            // Logic in analyzePoints clears processedPoints.
            // We can just use the highlight logic since we know the ID.
            const found = state.processedPoints.find(p => p.id === name);
            if (found) {
                map.flyTo([found.lat, found.lng], 15);
                L.popup()
                    .setLatLng([found.lat, found.lng])
                    .setContent(`<b>${found.id}</b><br>Added Manually`)
                    .openOn(map);
                highlightTableRow(found.id);
            }
        }, 500); // Wait for analyzePoints async chunks
    }, 100);
});


// Start
loadGeoData();
// --- Resize Logic ---
const resizeHandle = document.getElementById('resizeHandle');
const tableContainer = document.getElementById('tableContainer');
let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'row-resize';
    e.preventDefault(); // Prevent text selection
});

document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // Calculate new height based on mouse position
    // We want the height to be the distance from the bottom of the container to the mouse Y
    // But since it's a flex item at the bottom, we can perhaps just set height directly based on container bottom - mouse Y

    const containerRect = tableContainer.parentElement.getBoundingClientRect();
    const newHeight = containerRect.bottom - e.clientY;

    // Constraints
    const minHeight = 150;
    const maxHeight = containerRect.height - 100; // Leave some space for map

    if (newHeight >= minHeight && newHeight <= maxHeight) {
        tableContainer.style.height = `${newHeight}px`;
    }
});

document.addEventListener('mouseup', () => {
    if (isResizing) {
        isResizing = false;
        document.body.style.cursor = 'default';
        // Trigger map resize if needed (Leaflet checks size periodically but good to force)
        map.invalidateSize();
    }
});
