(function(){
  "use strict";

  var CONFIG = {
    globeRadius: 1,
    atmosphereRadius: 1.06,
    minDistance: 1.08,
    maxDistance: 4.2,
    startDistance: 2.6,
    labelZoomThreshold: 2.2,
    autoRotateSpeed: 0.045
  };

  var state = {
    layers: { surface: true, grid: false, warehouses: true, labels: true, spin: true },
    dragging: false,
    lastPointer: null,
    spherical: { theta: 0.6, phi: 1.3, radius: CONFIG.startDistance },
    pinchStartDist: null,
    pinchStartRadius: null
  };

  var deg2rad = function(d){ return d * Math.PI / 180; };
  function lonLatToXY(lon, lat, w, h){
    return [ (lon + 180) / 360 * w, (90 - lat) / 180 * h ];
  }

  function latLonToVector3(lat, lon, radius){
    var phi = deg2rad(90 - lat);
    var theta = deg2rad(lon + 180);
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
  }

  function buildFallbackTexture(){
    var w = 2048, h = 1024;
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#0a2a4a";
    ctx.fillRect(0,0,w,h);
    ctx.fillStyle = "#2d5a3c";
    ctx.beginPath();
    ctx.arc(w*0.3, h*0.4, 250, 0, Math.PI*2);
    ctx.arc(w*0.55, h*0.35, 180, 0, Math.PI*2);
    ctx.arc(w*0.55, h*0.65, 140, 0, Math.PI*2);
    ctx.arc(w*0.75, h*0.7, 100, 0, Math.PI*2);
    ctx.fill();
    return c;
  }

  function buildGridTexture(){
    var w = 1024, h = 512;
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = "rgba(94,230,200,0.3)";
    ctx.lineWidth = 1;
    for(var lon=-180; lon<=180; lon+=30){
      var x = lonLatToXY(lon,0,w,h)[0];
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
    }
    return c;
  }

  var scene, camera, renderer, globe, atmosphere, starField, gridMesh;
  var countryLabelEls = [];
  var dcPoints = null;
  var dcLabelEl = null;
  var dcData = [];
  var clusters = [];
  var clusterLevel = -1;
  var selectedCluster = null;
  var overlaysDirty = true;
  var selectedDC = null;
  var camDirScratch = new THREE.Vector3();
  var projScratch = new THREE.Vector3();
  var dragStart = null;

  function initScene(){
    var container = document.getElementById("app");
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.01, 100);

    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    var sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(5,3,5);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x334466, 1.2));

    var globeGeo = new THREE.SphereGeometry(CONFIG.globeRadius, 96, 96);
    var localTex = new THREE.CanvasTexture(buildFallbackTexture());
    var globeMat = new THREE.MeshPhongMaterial({ map: localTex, specular: 0x222222, shininess: 15 });

    globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);

    var textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin('anonymous');
    textureLoader.load(
      'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg',
      function(tex) {
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
        globeMat.map = tex;
        globeMat.needsUpdate = true;
      }
    );

    var gridTex = new THREE.CanvasTexture(buildGridTexture());
    var gridGeo = new THREE.SphereGeometry(CONFIG.globeRadius*1.002, 96, 96);
    gridMesh = new THREE.Mesh(gridGeo, new THREE.MeshBasicMaterial({ map: gridTex, transparent:true, opacity:0 }));
    scene.add(gridMesh);

    var atmoGeo = new THREE.SphereGeometry(CONFIG.atmosphereRadius, 64, 64);
    var atmoMat = new THREE.ShaderMaterial({
      vertexShader: "varying vec3 vNormal; void main(){ vNormal = normalize( normalMatrix * normal ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
      fragmentShader: "varying vec3 vNormal; void main(){ float intensity = pow( 0.56 - dot( vNormal, vec3(0.0,0.0,1.0) ), 3.0 ); gl_FragColor = vec4( 0.35, 0.85, 0.95, 1.0 ) * intensity; }",
      blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true
    });
    atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
    scene.add(atmosphere);

    starField = buildStars();
    scene.add(starField);

    applySpherical();
    window.addEventListener("resize", onResize);

    // Init overlay elements, then load both CSVs in parallel
    initOverlayEls();
    initClusterPanel();
    loadCountryData();
    loadDCData();
  }

  function buildStars(){
    var count = 1500;
    var positions = new Float32Array(count*3);
    for(var i=0;i<count;i++){
      var r = 30 + Math.random()*20;
      var theta = Math.random()*Math.PI*2;
      var phi = Math.acos(2*Math.random()-1);
      positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i*3+2] = r * Math.cos(phi);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions,3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color:0xffffff, size:0.065, transparent:true, opacity:0.8 }));
  }

  function onResize(){
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    overlaysDirty = true;
  }

  function applySpherical(){
    var s = state.spherical;
    s.phi = Math.max(0.18, Math.min(Math.PI - 0.18, s.phi));
    s.radius = Math.max(CONFIG.minDistance, Math.min(CONFIG.maxDistance, s.radius));
    camera.position.set(
      s.radius * Math.sin(s.phi) * Math.cos(s.theta),
      s.radius * Math.cos(s.phi),
      s.radius * Math.sin(s.phi) * Math.sin(s.theta)
    );
    camera.lookAt(0,0,0);
    overlaysDirty = true;
  }

  function initControls(){
    var dom = renderer.domElement;
    dom.style.cursor = "grab";

    dom.addEventListener("pointerdown", function(e){
      state.dragging = true;
      state.lastPointer = { x:e.clientX, y:e.clientY };
      dragStart = { x:e.clientX, y:e.clientY };
      dom.style.cursor = "grabbing";
      dom.setPointerCapture(e.pointerId);
    });

    dom.addEventListener("pointermove", function(e){
      if(state.dragging){
        var dx = e.clientX - state.lastPointer.x;
        var dy = e.clientY - state.lastPointer.y;
        state.lastPointer = { x:e.clientX, y:e.clientY };
        // Scale by altitude above surface: near-zero when close, normal at start, faster when far
        var altitude = state.spherical.radius - CONFIG.globeRadius;
        var baseAltitude = CONFIG.startDistance - CONFIG.globeRadius;
        var zoomFactor = altitude / baseAltitude;
        state.spherical.theta += dx * 0.0045 * zoomFactor;
        state.spherical.phi -= dy * 0.0045 * zoomFactor;
        applySpherical();
      } else {
        // Hover feedback: pointer when a dot sits under the cursor
        dom.style.cursor = findClusterAt(e.clientX, e.clientY) === null ? "grab" : "pointer";
      }
    });

    ["pointerup","pointercancel","pointerleave"].forEach(function(ev){
      dom.addEventListener(ev, function(){
        state.dragging = false;
        // Keep dragStart so the click handler can still measure movement
      });
    });

    dom.addEventListener("click", function(e){
      if(!dragStart) return;
      var moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
      dragStart = null;
      dom.style.cursor = "grab";
      if(moved < 6) pickDC(e.clientX, e.clientY);
    });

    dom.addEventListener("wheel", function(e){
      e.preventDefault();
      state.spherical.radius += e.deltaY * 0.0022;
      applySpherical();
    }, { passive:false });

    dom.addEventListener("touchstart", function(e){
      if(e.touches.length === 2){
        state.pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        state.pinchStartRadius = state.spherical.radius;
      }
    }, { passive:true });
    dom.addEventListener("touchmove", function(e){
      if(e.touches.length === 2 && state.pinchStartDist){
        var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        state.spherical.radius = state.pinchStartRadius * (state.pinchStartDist / d);
        applySpherical();
      }
    }, { passive:true });
    dom.addEventListener("touchend", function(e){
      if(e.touches.length < 2) state.pinchStartDist = null;
    });
  }

  // Create overlay DOM elements (DC marker); country labels added after CSV load
  function initOverlayEls(){
    var layer = document.getElementById("overlayLayer");

    dcLabelEl = document.createElement("div");
    dcLabelEl.className = "wh-marker mono";
    var nameSpan = document.createElement("span");
    nameSpan.className = "wh-name";
    dcLabelEl.appendChild(nameSpan);
    var pin = document.createElement("div");
    pin.className = "wh-pin";
    dcLabelEl.appendChild(pin);
    layer.appendChild(dcLabelEl);
  }

  // Country labels are optional: on failure the globe keeps working
  function loadCountryData(){
    fetch("countries.csv")
      .then(function(res){
        if(!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function(text){
        var countries = parseCSV(text);
        var layer = document.getElementById("overlayLayer");
        countries.forEach(function(entry){
          var el = document.createElement("div");
          el.className = "label mono";
          var nameSpan = document.createElement("span");
          nameSpan.textContent = entry.name;
          el.appendChild(nameSpan);
          var pin = document.createElement("div");
          pin.className = "pin";
          el.appendChild(pin);
          layer.appendChild(el);
          countryLabelEls.push({ el: el, pos: latLonToVector3(entry.lat, entry.lon, CONFIG.globeRadius) });
        });
        overlaysDirty = true;
      })
      .catch(function(err){
        console.warn("countries.csv failed, labels disabled:", err.message);
      });
  }

  function loadDCData(){
    var msg = document.getElementById("loadingMsg");
    fetch("world_data_centers.csv")
      .then(function(res){
        if(!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function(text){
        dcData = parseCSV(text);
        buildDCPoints(dcData);
        document.getElementById("dcCount").textContent = dcData.length + " NODES";
        document.getElementById("loading").classList.add("hide");
      })
      .catch(function(err){
        msg.textContent = "ERRO AO CARREGAR CSV: " + err.message;
      });
  }

  function parseCSV(text){
    var lines = text.trim().split(/\r?\n/);
    var header = lines[0].split(",").map(function(h){ return h.trim().toLowerCase(); });
    var iName = header.indexOf("name");
    var iLat = header.indexOf("lat");
    var iLon = header.indexOf("lon");
    if(iName < 0 || iLat < 0 || iLon < 0) throw new Error("Colunas name/lat/lon não encontradas");
    var out = [];
    for(var i = 1; i < lines.length; i++){
      var line = lines[i];
      if(!line) continue;
      var fields = [];
      var cur = "", inQ = false;
      for(var c = 0; c < line.length; c++){
        var ch = line[c];
        if(inQ){
          if(ch === '"'){
            if(c+1 < line.length && line[c+1] === '"'){ cur += '"'; c++; }
            else inQ = false;
          } else cur += ch;
        } else {
          if(ch === '"') inQ = true;
          else if(ch === ','){ fields.push(cur); cur = ""; }
          else cur += ch;
        }
      }
      fields.push(cur);
      var lat = parseFloat(fields[iLat]);
      var lon = parseFloat(fields[iLon]);
      if(isNaN(lat) || isNaN(lon)) continue;
      // Build full record from all header columns
      var rec = { lat: lat, lon: lon };
      for(var h = 0; h < header.length; h++){
        if(h === iLat || h === iLon) continue;
        rec[header[h]] = (fields[h] || "").trim();
      }
      if(!rec.name) rec.name = "DC-" + i;
      out.push(rec);
    }
    return out;
  }

  // Solid circle sprite (hard edge, no gradient blur)
  function buildDotTexture(){
    var size = 64;
    var c = document.createElement("canvas");
    c.width = size; c.height = size;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "rgba(0,238,255,1)";
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2 - 1, 0, Math.PI*2);
    ctx.fill();
    return new THREE.CanvasTexture(c);
  }

  function buildDCPoints(dataCenters){
    var r = CONFIG.globeRadius * 1.005;
    for(var i = 0; i < dataCenters.length; i++){
      dataCenters[i].renderPos = latLonToVector3(dataCenters[i].lat, dataCenters[i].lon, r);
    }
    if(dcPoints){ scene.remove(dcPoints); dcPoints.geometry.dispose(); dcPoints.material.dispose(); dcPoints = null; }
    clusterLevel = -1;
    refreshClusters(true);
  }

  // Merge radius in degrees, derived from screen scale so circles never visually overlap
  function clusterThresholdDeg(){
    var dist = Math.max(state.spherical.radius, CONFIG.globeRadius * 1.001);
    var pxPerDeg = (window.innerHeight * 0.5) / dist * (Math.PI / 180);
    return Math.max(0.12, Math.min(9, 14 / pxPerDeg));
  }

  // Greedy single-pass clustering: each DC joins the nearest existing cluster
  // within the merge radius, otherwise it starts a new one. Grid-accelerated so
  // neighbours are only clusters sharing an adjacent cell.
  function clusterize(threshold){
    var cell = threshold;
    var grid = {};
    var list = [];

    function nearClusters(lat, lon){
      var out = [];
      var gx = Math.round(lat / cell), gy = Math.round(lon / cell);
      for(var a = -1; a <= 1; a++){
        for(var b = -1; b <= 1; b++){
          var arr = grid[(gx + a) + "|" + (gy + b)];
          if(!arr) continue;
          for(var t = 0; t < arr.length; t++) out.push(arr[t]);
        }
      }
      return out;
    }

    var cosLat = 1;
    for(var i = 0; i < dcData.length; i++){
      var d = dcData[i];
      cosLat = Math.max(Math.cos(deg2rad(d.lat)), 0.15);
      var found = -1, bestD2 = threshold * threshold;

      var cand = nearClusters(d.lat, d.lon);
      for(var c = 0; c < cand.length; c++){
        var cl = list[cand[c]];
        var dLat = d.lat - cl.lat;
        var dLon = (d.lon - cl.lon) * cosLat;
        var d2 = dLat * dLat + dLon * dLon;
        if(d2 < bestD2){ bestD2 = d2; found = cand[c]; }
      }

      if(found >= 0){
        var target = list[found];
        target.count++;
        target.members.push(i);
        // Incremental mean keeps the centre stable without rescanning members
        target.lat += (d.lat - target.lat) / target.count;
        target.lon += (d.lon - target.lon) / target.count;
        // Re-register the cluster if its centre drifted into a new cell
        var nkey = Math.round(target.lat / cell) + "|" + Math.round(target.lon / cell);
        var slot = grid[nkey] || (grid[nkey] = []);
        if(slot.indexOf(found) === -1) slot.push(found);
      } else {
        list.push({ lat: d.lat, lon: d.lon, count: 1, members: [i] });
        var key = Math.round(d.lat / cell) + "|" + Math.round(d.lon / cell);
        var g = grid[key] || (grid[key] = []);
        g.push(list.length - 1);
      }
    }
    return list;
  }

  function refreshClusters(force){
    var threshold = clusterThresholdDeg();
    if(!force && threshold === clusterLevel) return;
    clusterLevel = threshold;

    var list = clusterize(threshold);
    var r = CONFIG.globeRadius * 1.005;

    clusters = list.map(function(cl){
      var lat = cl.lat, lon = cl.lon;
      // Snap the marker onto a real facility so no dot floats over open sea
      if(cl.count > 1){
        var best = Infinity;
        for(var k = 0; k < cl.members.length; k++){
          var dc = dcData[cl.members[k]];
          var dLat = dc.lat - cl.lat;
          var dLon = (dc.lon - cl.lon) * Math.max(Math.cos(deg2rad(cl.lat)), 0.15);
          var d2 = dLat * dLat + dLon * dLon;
          if(d2 < best){ best = d2; lat = dc.lat; lon = dc.lon; }
        }
      }
      cl.lat = lat; cl.lon = lon;
      cl.aSize = Math.min(0.013 + Math.log10(cl.count) * 0.013, 0.06);
      cl.pos = latLonToVector3(lat, lon, r);
      return cl;
    });

    var positions = new Float32Array(clusters.length * 3);
    var sizes = new Float32Array(clusters.length);
    for(var c = 0; c < clusters.length; c++){
      var p = clusters[c].pos;
      positions[c*3] = p.x; positions[c*3+1] = p.y; positions[c*3+2] = p.z;
      sizes[c] = clusters[c].aSize;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    if(dcPoints){ scene.remove(dcPoints); dcPoints.geometry.dispose(); dcPoints.material.dispose(); }
    dcPoints = new THREE.Points(geo, makeClusterMaterial());
    scene.add(dcPoints);

    selectedCluster = null;
    dcLabelEl.style.opacity = "0";
    closeClusterPanel();
    overlaysDirty = true;
  }

  function makeClusterMaterial(){
    var mat = new THREE.PointsMaterial({
      color: 0x00eeff, size: 1, sizeAttenuation: true,
      map: buildDotTexture(), transparent: true, opacity: 0.95,
      alphaTest: 0.05, depthWrite: false
    });
    // Per-point size via a custom attribute (avoids clashing with the built-in size uniform)
    mat.onBeforeCompile = function(shader){
      shader.vertexShader = "attribute float aSize;\n" + shader.vertexShader.replace(
        /gl_PointSize\s*=\s*size\s*;/,
        "gl_PointSize = aSize;"
      );
    };
    return mat;
  }

  // Returns the front-facing cluster under the cursor, or null
  function findClusterAt(clientX, clientY){
    if(!dcPoints || !state.layers.warehouses) return null;
    camera.updateMatrixWorld();
    camDirScratch.copy(camera.position).normalize();

    var halfW = window.innerWidth / 2, halfH = window.innerHeight / 2;
    var halfH_px = window.innerHeight * 0.5;
    var camPos = camera.position;
    var best = null, bestScore = Infinity;

    for(var i = 0; i < clusters.length; i++){
      var cl = clusters[i];
      if(cl.pos.dot(camDirScratch) <= 0) continue;
      projScratch.copy(cl.pos).project(camera);
      if(projScratch.z < -1 || projScratch.z > 1) continue;
      var sx = (projScratch.x * halfW) + halfW;
      var sy = (-projScratch.y * halfH) + halfH;
      var ddx = sx - clientX, ddy = sy - clientY;
      var d2 = ddx * ddx + ddy * ddy;

      // Exact on-screen diameter of the drawn dot, using its real view depth:
      // gl_PointSize = aSize * (viewportHeight/2) / distance(camera -> point)
      var vx = cl.pos.x - camPos.x, vy = cl.pos.y - camPos.y, vz = cl.pos.z - camPos.z;
      var dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if(dist < 1e-6) continue;
      var diameterPx = (cl.aSize * halfH_px) / dist;

      // Whole circle is clickable, plus a few px of slack
      var radiusPx = Math.max(14, diameterPx * 0.5 + 5);
      if(d2 > radiusPx * radiusPx) continue;

      var score = d2 / (radiusPx * radiusPx);
      if(score < bestScore){ bestScore = score; best = i; }
    }
    return best;
  }

  // Screen-space picking: opens the cluster list for the dot under the cursor
  function pickDC(clientX, clientY){
    var best = findClusterAt(clientX, clientY);
    selectedCluster = best === null ? null : clusters[best];
    if(selectedCluster){
      openClusterPanel(selectedCluster);
    } else {
      closeClusterPanel();
    }
    overlaysDirty = true;
  }

  var clusterPanelEl = null, clusterListEl = null, clusterTitleEl = null;

  function initClusterPanel(){
    clusterPanelEl = document.getElementById("clusterPanel");
    clusterListEl = document.getElementById("clusterList");
    clusterTitleEl = document.getElementById("clusterTitle");
    document.getElementById("clusterClose").addEventListener("click", function(){
      closeClusterPanel();
      selectedCluster = null;
      selectedDC = null;
      hideFocusMarker();
      overlaysDirty = true;
    });
  }

  function closeClusterPanel(){
    if(clusterPanelEl) clusterPanelEl.hidden = true;
  }

  function openClusterPanel(cl){
    if(!clusterPanelEl) initClusterPanel();
    var members = cl.members.map(function(i){ return dcData[i]; });

    if(cl.count === 1){
      clusterTitleEl.textContent = "1 DATA CENTER";
    } else {
      clusterTitleEl.textContent = cl.count + " DATA CENTERS PRÓXIMOS";
    }

    clusterListEl.innerHTML = "";
    var sorted = members.slice().sort(function(a, b){
      var na = (a.name || "").toLowerCase(), nb = (b.name || "").toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });

    sorted.forEach(function(dc){
      var item = document.createElement("div");
      item.className = "cluster-item";

      var name = document.createElement("div");
      name.className = "ci-name";
      name.textContent = dc.name;
      item.appendChild(name);

      var metaParts = [];
      if(dc.operator) metaParts.push(dc.operator);
      if(dc.facility_kind && dc.facility_kind !== "unclassified") metaParts.push(dc.facility_kind);
      var loc = [dc.city, dc.country].filter(Boolean).join(", ");
      if(loc) metaParts.push(loc);
      if(metaParts.length){
        var meta = document.createElement("div");
        meta.className = "ci-meta";
        meta.textContent = metaParts.join(" · ");
        item.appendChild(meta);
      }

      // Exact coordinates so the position can be located on any map
      var coords = document.createElement("div");
      coords.className = "ci-coords mono";
      coords.textContent = dc.lat.toFixed(5) + "°, " + dc.lon.toFixed(5) + "°";
      item.appendChild(coords);

      var links = [];
      if(dc.website) links.push(["site", dc.website]);
      if(dc.osm_url) links.push(["OSM", dc.osm_url]);
      if(links.length){
        var linkRow = document.createElement("div");
        linkRow.className = "ci-links";
        links.forEach(function(pair){
          var a = document.createElement("a");
          a.href = pair[1];
          a.textContent = pair[0];
          a.target = "_blank";
          a.rel = "noopener";
          a.addEventListener("click", function(ev){ ev.stopPropagation(); });
          linkRow.appendChild(a);
        });
        item.appendChild(linkRow);
      }

      // Click an item to fly to that facility's exact point
      item.addEventListener("click", function(){
        focusOn(dc.lat, dc.lon, dc);
      });

      clusterListEl.appendChild(item);
    });

    clusterPanelEl.hidden = false;
  }

  // Center the globe on a lat/lon so the point faces the camera
  function focusOn(lat, lon, dc){
    var s = state.spherical;
    // Camera theta must be PI - (lon+180) to match latLonToVector3's axis convention
    var targetTheta = Math.PI - deg2rad(lon + 180);
    var targetPhi = deg2rad(90 - lat);
    // Take the shortest angular path for theta
    var delta = targetTheta - s.theta;
    while(delta > Math.PI) delta -= 2 * Math.PI;
    while(delta < -Math.PI) delta += 2 * Math.PI;
    s.theta += delta;
    // phi is an angle: clamp to the polar limits, not the distance limits
    s.phi = Math.max(0.18, Math.min(Math.PI - 0.18, targetPhi));
    s.radius = Math.max(CONFIG.minDistance, Math.min(CONFIG.maxDistance, 1.12));
    // Force the finest clustering so this facility resolves on its own
    clusterLevel = -1;
    refreshClusters(true);
    selectedDC = dc || null;
    if(dc) showFocusMarker(dc);
    closeClusterPanel();
    selectedCluster = null;
    applySpherical();
  }

  // Marker showing the exact position of the focused facility
  var focusMarker = null;

  function showFocusMarker(dc){
    hideFocusMarker();
    var r = CONFIG.globeRadius * 1.012;
    var v = latLonToVector3(dc.lat, dc.lon, r);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([v.x, v.y, v.z], 3));
    var mat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.03, sizeAttenuation: true,
      map: buildDotTexture(), transparent: true, opacity: 1,
      alphaTest: 0.05, depthWrite: false, depthTest: false
    });
    focusMarker = new THREE.Points(geo, mat);
    focusMarker.renderOrder = 999;
    // Anchor for the label: the facility position lives in the geometry vertex
    focusMarker.userData.anchor = v;
    scene.add(focusMarker);

    dcLabelEl.querySelector(".wh-name").textContent = dc.name;
    overlaysDirty = true;
  }

  function hideFocusMarker(){
    if(!focusMarker) return;
    scene.remove(focusMarker);
    focusMarker.geometry.dispose();
    focusMarker.material.dispose();
    focusMarker = null;
  }

  function updateOverlays(){
    if(!overlaysDirty) return;
    overlaysDirty = false;

    camera.updateMatrixWorld();
    camDirScratch.copy(camera.position).normalize();
    var halfW = window.innerWidth / 2, halfH = window.innerHeight / 2;

    if(dcPoints) dcPoints.visible = state.layers.warehouses;

    var showLabels = state.layers.labels;
    var zoomT = Math.max(0, Math.min(1, (CONFIG.labelZoomThreshold - state.spherical.radius) / (CONFIG.labelZoomThreshold - CONFIG.minDistance)));

    countryLabelEls.forEach(function(item){
      var visible = showLabels && zoomT > 0.02 && item.pos.dot(camDirScratch) > 0.15 * item.pos.length();
      if(!visible){
        if(item.el.style.opacity !== "0"){
          item.el.style.opacity = "0";
        }
        return;
      }
      projScratch.copy(item.pos).project(camera);
      var x = Math.round((projScratch.x * halfW) * 100) / 100;
      var y = Math.round((-projScratch.y * halfH) * 100) / 100;
      item.el.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-100%)";
      item.el.style.opacity = zoomT.toFixed(2);
    });

    // Anchor the label to the focused facility marker, otherwise to the selected cluster
    var anchorPos = null, anchorText = "";
    if(selectedDC && focusMarker){
      anchorPos = focusMarker.userData.anchor;
      anchorText = selectedDC.name;
    } else if(selectedCluster){
      anchorPos = selectedCluster.pos;
      anchorText = selectedCluster.count === 1
        ? "1 data center"
        : selectedCluster.count + " data centers · clique para listar";
    }

    if(anchorPos && state.layers.warehouses){
      var facing = anchorPos.dot(camDirScratch) / anchorPos.length();
      if(facing < 0.12){
        dcLabelEl.style.opacity = "0";
      } else {
        projScratch.copy(anchorPos).project(camera);
        var dx = Math.round((projScratch.x * halfW) * 100) / 100;
        var dy = Math.round((-projScratch.y * halfH) * 100) / 100;
        dcLabelEl.style.transform = "translate(" + dx + "px," + dy + "px) translate(-50%,-100%)";
        dcLabelEl.querySelector(".wh-name").textContent = anchorText;
        dcLabelEl.style.opacity = "1";
      }
    } else {
      dcLabelEl.style.opacity = "0";
    }
  }

  var lastTime = performance.now();
  var fpsAccum = 0, fpsCount = 0, fpsTimer = 0;

  function tick(now){
    var dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if(state.layers.spin && !state.dragging){
      state.spherical.theta += CONFIG.autoRotateSpeed * dt;
      applySpherical();
    }
    starField.rotation.y += 0.0015 * dt;

    // Recompute clusters when zoom crosses a resolution threshold
    if(dcData.length && clusterThresholdDeg() !== clusterLevel){
      refreshClusters(false);
    }

    if(overlaysDirty){
      updateOverlays();
      updateTelemetry();
    }

    renderer.render(scene, camera);

    fpsAccum += dt; fpsCount++;
    fpsTimer += dt;
    if(fpsTimer > 0.5){
      var fpsEl = document.getElementById("fps");
      if(fpsEl) fpsEl.textContent = Math.round(fpsCount/fpsAccum) + " FPS";
      fpsAccum = 0; fpsCount = 0; fpsTimer = 0;
    }

    requestAnimationFrame(tick);
  }

  function updateTelemetry(){
    var altKm = Math.round((state.spherical.radius - 1) * 6371);
    document.getElementById("readAlt").textContent = altKm.toLocaleString("pt-BR") + " km";

    var phi = state.spherical.phi, theta = state.spherical.theta;
    var lat = 90 - (phi * 180 / Math.PI);
    var lon = ((theta * 180 / Math.PI) % 360) - 180;
    document.getElementById("readLatLon").textContent = lat.toFixed(1) + "°, " + lon.toFixed(1) + "°";
  }

  function initUI(){
    document.querySelectorAll("#panel .btn").forEach(function(btn){
      btn.addEventListener("click", function(){
        var layer = btn.dataset.layer;
        state.layers[layer] = !state.layers[layer];
        btn.classList.toggle("active", state.layers[layer]);

        if(layer === "surface") globe.visible = state.layers.surface;
        if(layer === "grid") gridMesh.material.opacity = state.layers.grid ? 0.9 : 0;
        overlaysDirty = true;
      });
    });
  }

  if(typeof THREE !== "undefined"){
    initScene();
    initControls();
    initUI();
    requestAnimationFrame(tick);
  }
})();
