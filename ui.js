// ui.js — DOM only. Reads the world and the current probe; writes no state.

const $ = id => document.getElementById(id);

const KIND_LABEL = {
  residential: 'Housing', commercial: 'Commercial', industrial: 'Industrial',
  civic: 'Civic', minor: 'Outbuilding', other: 'Unclassified',
};
const SOURCE_LABEL = {
  tag: 'tagged in OSM', poi: 'inferred from a business inside',
  landuse: 'inferred from the surrounding zone', none: 'no land-use data',
};

export class UI {
  constructor(world) { this.setWorld(world); }

  setWorld(world) {
    this.world = world;
    const s = world.stats();
    $('place-name').textContent = world.name.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
    $('place-sub').textContent = shortLabel(world.label);

    const rows = [
      ['Area', `${s.areaKm2.toFixed(2)} km²`],
      ['Buildings', s.buildings.toLocaleString()],
      ['Streets', `${s.roadKm.toFixed(1)} km`],
      ['Relief', `${s.relief.toFixed(0)} m`],
      ['Elevation', `${world.minH.toFixed(0)} – ${world.maxH.toFixed(0)} m`],
    ];
    const m = world.meta;
    if (m?.heightSource) {
      const { fromOsm, guessed } = m.heightSource;
      const pct = Math.round(100 * fromOsm / Math.max(1, fromOsm + guessed));
      rows.push(['Real heights', `${pct}% of buildings`]);
    }
    $('place-stats').innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  /** hit = {x, z, building} | null */
  showProbe(hit) {
    const body = $('probe-body');
    if (!hit) {
      body.className = 'empty';
      body.textContent = 'move the mouse over the map';
      return;
    }
    const w = this.world;
    const h = w.heightAt(hit.x, hit.z);
    const slope = w.slopeAt(hit.x, hit.z);
    const roadD = w.roadDistAt(hit.x, hit.z);
    const geo = geoOf(w, hit.x, hit.z);

    body.className = '';
    const b = hit.building;
    let html = '';

    if (b) {
      const tags = [`<span class="tag">${KIND_LABEL[b.kind] || b.kind}</span>`];
      if (b.g) tags.push('<span class="tag guess">height invented</span>');
      html += `<div style="font-weight:600;margin-bottom:3px">${esc(b.n || 'Unnamed building')}</div>`;
      html += tags.join('') + '<br>';
      html += `<div style="margin-top:6px">`;
      html += `${b.h.toFixed(1)} m tall · ${b.lv} floor${b.lv === 1 ? '' : 's'} · ${Math.round(b.a)} m² footprint<br>`;
      html += `<span style="color:var(--dim)">land use ${SOURCE_LABEL[b.ks] || b.ks}</span>`;
      if (b.gx - b.gm > 1.5) {
        html += `<br><span style="color:var(--warn)">built across ${(b.gx - b.gm).toFixed(1)} m of slope</span>`;
      }
      html += `</div>`;
    } else {
      html += `<div style="font-weight:600;margin-bottom:3px">Open ground</div>`;
    }

    html += `<div style="margin-top:8px;color:var(--dim);font-size:11.5px">`;
    html += `${h.toFixed(1)} m elevation · ${(slope * 100).toFixed(0)}% grade<br>`;
    html += `${roadD < 1 ? 'on a road' : `${roadD.toFixed(0)} m to nearest road`}<br>`;
    html += `${geo}`;
    html += `</div>`;

    body.innerHTML = html;
  }
}

/** Real-world coordinates of a local point, so you can go look at it. */
function geoOf(w, x, z) {
  const mLat = 111132.92 - 559.82 * Math.cos(2 * w.origin.lat * Math.PI / 180);
  const mLon = 111412.84 * Math.cos(w.origin.lat * Math.PI / 180);
  const lat = w.origin.lat - z / mLat;
  const lon = w.origin.lon + x / mLon;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function shortLabel(label) {
  if (!label) return '';
  const parts = label.split(',').map(s => s.trim());
  return parts.length <= 3 ? label : parts.slice(0, 3).join(', ');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
