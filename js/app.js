const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
// A shortcut $('map') means document.getElementById('map')
const $ = id => document.getElementById(id);
// Makes text safe to put inside HTML. 
// This matters because café names come from the public OSM database, and you insert them with innerHTML.
//Without esc, the browser would create that image element and run the code. A real attacker could use this to steal data or redirect your users (this is called XSS, cross-site scripting). Even a harmless name like Coffee & Co or Café <Le Port> can break your layout, because the browser may read <Le Port> as a tag.
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// creating the map //
const map = L.map('map', { zoomControl: false }).setView([36.7538, 3.0588], 14); // Algiers
// Adds the zoom buttons back, in the top-right corner.

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);


// Marker setup and state //

//Indicidual container for cafes markers  -- Its benefit is that layer.clearLayers() removes all of them at once.
const layer = L.layerGroup().addTo(map);
//creating an icon
//1-using html
const cupIcon = L.divIcon({ className: 'cup', html: '☕', iconSize: [34, 34], iconAnchor: [17, 17] });
// 2 -using image
// const cupIcon = L.icon({
//   iconUrl: '../assets/icons/iconCafe.png',  
//   iconSize: [36, 36],          // displayed width and height in pixels
//   iconAnchor: [18, 36],        // the point of the image placed on the coordinate
//   popupAnchor: [0, -36], // where the popup opens, relative to the anchor
//   className:   'cup'    
// });

let markers = {}, userMarker = null, moving = false;

// ** overpass(): ask the server, with fallbacks
async function overpass(query) {
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
      // res.ok is true for status 200 to 299
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      //Overpass can return valid JSON that contains an error message in remark
      if (data.remark && data.remark.includes('error')) throw new Error(data.remark);
      // console.log("overpass : data ",data);

      return data;

    } catch (err) { console.warn('Failed:', url, err.message); }
  }
  throw new Error('All Overpass servers failed');
}

// ** km(): distance between two points the haversine formula, /
function km(aLat, aLon, bLat, bLon) {
    // r convert degres to radians *(PI / 180)
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

//Under 1 km it shows meters (0.43 becomes “430 m”), otherwise kilometers with one decimal.
const fmt = d => d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km';

// chipsFor produces the labels ["coffee shop", "pizza", "Takeaway", "Wi-Fi"] from the cafe tags
function chipsFor(t) {
  const c = [];
    //OSM stores multiple values as "coffee_shop;pizza". 

  //for example cafe_tag :  { amenity: "cafe", takeaway: "yes", cuisine: "coffee_shop;pizza" }
  if (t.cuisine) t.cuisine.split(';').forEach(x => c.push(x.replace(/_/g, ' ')));
  if (t.takeaway === 'yes') c.push('Takeaway');
  if (t.outdoor_seating === 'yes') c.push('Outdoor seating');
  if (t.internet_access === 'wlan') c.push('Wi-Fi');
  if (t.wheelchair === 'yes') c.push('Accessible');

    //for exemple result output : ["coffee shop", "pizza", "Takeaway", "Wi-Fi"]
  // console.log("chipsFor(cafe_tag) :",c);

  return c;
}

function load() {
     //getCenter() Returns  the current map center (c.lat and c.lng).
  const c = map.getCenter();

  const r = +$('radius').value;// The radius dropdown’s value is a string like "1000", and the + in front converts it to a number.

  //Resets the interface: hide the “Search this area” button, show “…” in the counter, and show a loading message in the list.
  $('area-btn').hidden = true;
  $('count').textContent = '…';
  $('list').innerHTML = '<p class="note">Loading cafés…</p>';
  
      //The Overpass query
            // [out:json]: return JSON.
            // [timeout:25]: give up after 25 seconds.
            // nwr: search nodes, ways and relations.
            // ["amenity"="cafe"]: only elements with that tag.
            // (around:r,lat,lng): within r meters of the center.
            // out center tags;: return tags and, for ways, a center point.
  const q = `[out:json][timeout:25];nwr["amenity"="cafe"](around:${r},${c.lat},${c.lng});out center tags;`;
  overpass(q)
    .then((d) => show(d.elements, c))//success
    .catch(() => {//failure
      $("count").textContent = "0";
      $("list").innerHTML =
        '<p class="note">Could not load cafés. Wait a moment, then press “Search this area”.</p>';
    });
}

// ** show(): turn results into markers and cards **//
const NAME_KEYS = ["name", "name:fr", "name:en", "name:ar", "alt_name", "official_name", "short_name", "brand", "operator"];

//retreive the avilable cafe name from tag 
function cafeName(tags) {
  for (const key of NAME_KEYS) {
    if (tags[key]) return tags[key];
  }
  return "Unnamed café";
}

function show(elements, c) {
  //split features(takeaway=yes,wifi=no...) on keys and values from (select html element)
  const [fk, fv] = $('filter').value.split('=');
  
  // map(): Simplifies each raw element onto [(id1,t1,lat1,lon1,d1),(id2,t2,lat2,lon2,d2)....]
  //?? means “use the left value unless it’s null or undefined”
  // The ?. stops an error if center doesn’t exist.
  const cafes = elements
    .map(e => ({ id: e.id, t: e.tags || {}, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }))
    .filter(x => x.lat != null && (!fk || x.t[fk] === fv))
    .map(x => ({ ...x, d: km(c.lat, c.lng, x.lat, x.lon) }))
    .sort((a, b) => a.d - b.d);//Sorts nearest first. A negative result puts a before b
    //[(id1,t1,lat1,lon1,d1),(id2,t2,lat2,lon2,d2)....].sort((a,b)=>a.d-b.d)

    // ** clear oldest layers & markers
  layer.clearLayers(); markers = {};
  $('count').textContent = cafes.length;
  $('list').innerHTML = cafes.length ? '' : '<p class="note">No cafés found. Try a larger radius or move the map.</p>';

  cafes.forEach((x) => {
      //x=(id1,t1,lat1,lon1,d1)

    const name = cafeName(x.t);
  //Creates the marker with your cup icon, adds it to the layer group, attaches a popup,
    //  and when this marker is clicked, highlight its card and scroll to it. new Marker([50.5, 30.5]).addTo(map);
    markers[x.id] = L.marker([x.lat, x.lon], { icon: cupIcon })
      .addTo(layer)
      .bindPopup(`<b>${name}</b>`)
      .on("click", () => select(x.id, true));

    //Builds an address
    const addr = [
      [x.t["addr:housenumber"], x.t["addr:street"]].filter(Boolean).join(" "),
      x.t["addr:city"],
    ]
      .filter(Boolean)
      .join(", ");

    //Creates a new element, <article class="card" data-id="123456">.
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.id = x.id;//x=(id,t,lat1,lon1,d1) <=cafe
    // <h3> Cafe name </h3>
    el.innerHTML = `<h3>${name}</h3>
      <div class="chips">
      ${chipsFor(x.t)
        .map((c) => `<span>${c}</span>`)
        .join("")}
      </div>

      <p class="addr">${addr || "Address not listed"}</p>
      <p class="hours">${x.t.phone || "Phones not listed"}</p>
      <div class="row"><a class="btn" target="_blank" rel="noopener"
        href="https://www.google.com/maps/dir/?api=1&destination=${x.lat},${x.lon}">Directions</a>
        <span class="dist">${fmt(x.d)}</span></div>`;

    el.addEventListener("click", (e) => {
      if (!e.target.closest("a")) {
        select(x.id);
        map.flyTo([x.lat, x.lon], 17);
      }
    });
    $("list").appendChild(el);
  });
  console.table(cafes.map(c => c.t))
}

function select(id, scroll) {
  //Loops over all cards. toggle('active', condition) 
  // adds the class when the condition is true and removes it when false,
  document.querySelectorAll(".card")
    .forEach((c) => c.classList.toggle("active", c.dataset.id == id));

  //Object.entries turns the object into [key, value] pairs. 
  //m._icon is the HTML element Leaflet created for the icon.
  Object.entries(markers).forEach(([k, m]) =>
    m._icon?.classList.toggle("active", k == id),
  );
  if (scroll)
    document
      .querySelector(`.card[data-id="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/// Only when a marker was clicked (scroll is true), find that card and scroll the list to it smoothly.
function go(lat, lon, zoom = 15) {
  moving = true;
  map.setView([lat, lon], zoom);
  moving = false;
  load();
}

// **EventListener ** //
$('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  $('location-status').textContent = 'Searching…';
  try {
    //Sends a request to Nominatim, OpenStreetMap's geocoding service, 
    // which turns place names into coordinates:
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
    
    //Parses the response. Nominatim returns a list,
    //  such as [{ lat: "36.75", lon: "3.05", display_name: "Alger, ..." }]
    const [hit] = await res.json();
    
    if (!hit) { 
      $('location-status').textContent = 'Place not found. Try a different name.'; return;
    }
    $('location-status').textContent = 'Distance from map center';

    //Calls your go() function, which moves the map and runs load() to fetch cafés. The + in front converts the text values ("36.75") into numbers, 
        // because Nominatim returns coordinates as strings.
    go(+hit.lat, +hit.lon);
  } catch {
     $('location-status').textContent = 'Search failed. Check your connection.'; 
    }
});

$('find-location').addEventListener('click', () => {
  const s = $('location-status');
  if (!navigator.geolocation) {
     s.textContent = 'Geolocation is not supported by your browser.'; return; 
  }
  s.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude } = pos.coords;
    s.textContent = 'Distance from map center';
    if (userMarker) userMarker.setLatLng([latitude, longitude]);
    else userMarker = L.marker([latitude, longitude],
      { icon: L.divIcon({ className: 'me', iconSize: [18, 18] }) }).addTo(map).bindPopup('You are here');
    go(latitude, longitude);
  }, err => {
    s.textContent = ({ 1: 'Location permission was denied.', 2: 'Your location is unavailable.', 3: 'Location request timed out.' })[err.code] || 'Location error.';
  },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});

$('area-btn').addEventListener('click', load);
$('radius').addEventListener('change', load);
$('filter').addEventListener('change', load);
map.on('dragend', () => { if (!moving) $('area-btn').hidden = false; });

load();