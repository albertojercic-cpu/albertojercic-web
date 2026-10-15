// Visor 3D del modelo IFC del Habitáculo (web-ifc + three.js). Se carga solo al presionar "Cargar visor 3D".
// Etapa 1: vistas rápidas, ocultar cubierta, color por material, terreno, cubo de navegación y ficha al hacer clic.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as WebIFC from "./vendor/web-ifc-api.js";

// Nombres en español de las clases IFC del modelo
const CLASES = {
  IfcWall: "Muro", IfcSlab: "Losa / piso", IfcRoof: "Cubierta", IfcColumn: "Pilar", IfcBeam: "Viga",
  IfcMember: "Elemento estructural", IfcFooting: "Fundación", IfcWindow: "Ventana", IfcDoor: "Puerta",
  IfcPlate: "Placa / panel", IfcCovering: "Revestimiento", IfcFurniture: "Mobiliario", IfcLightFixture: "Luminaria",
  IfcFlowTerminal: "Artefacto sanitario", IfcBuildingElementProxy: "Elemento genérico", IfcGeographicElement: "Terreno",
  IfcCurtainWall: "Muro cortina", IfcStair: "Escalera", IfcRailing: "Baranda"
};
const BLANCO = 0xe9e4dc;

export async function iniciarVisor({ contenedor, ifcUrl, onEstado }) {
  const estado = t => onEstado && onEstado(t);

  // ---------- Escena ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  contenedor.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45; // ambiente suave para que el modelo blanco tenga volumen
  const sol = new THREE.DirectionalLight(0xfff6ea, 2.2);
  sol.position.set(30, 50, 25);
  scene.add(sol, new THREE.HemisphereLight(0xffffff, 0x6f655d, 0.45));

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = true;
  // Como en Revit: arrastrar gira, rueda acerca, rueda presionada desplaza
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };

  // ---------- Lectura del IFC ----------
  estado("Descargando modelo…");
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(new URL("./vendor/", import.meta.url).href, true);
  await api.Init();
  const resp = await fetch(ifcUrl);
  if (!resp.ok) throw new Error("No se pudo descargar el modelo (" + resp.status + ")");
  const datos = new Uint8Array(await resp.arrayBuffer());
  estado("Procesando geometría…");
  await new Promise(r => setTimeout(r, 30));
  const modelID = api.OpenModel(datos, { COORDINATE_TO_ORIGIN: true });

  const modelo = new THREE.Group();
  scene.add(modelo);
  const matColor = new Map();   // color del IFC -> material
  const matBlanco = new Map();  // opacidad -> material blanco
  const porElemento = new Map(); // expressID -> [mallas]
  const claseDe = new Map();     // expressID -> clase IFC
  const matrix = new THREE.Matrix4();
  const matAristas = new THREE.LineBasicMaterial({ color: 0x392f2b, transparent: true, opacity: 0.32 });

  function materialColor(c) {
    const k = [c.x, c.y, c.z, c.w].map(v => v.toFixed(3)).join(",");
    if (!matColor.has(k)) {
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(c.x, c.y, c.z, THREE.SRGBColorSpace), roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide, transparent: c.w < 0.99, opacity: c.w, depthWrite: c.w >= 0.99 });
      matColor.set(k, m);
    }
    return matColor.get(k);
  }
  function materialBlanco(op) {
    const k = op < 0.99 ? "t" : "o";
    if (!matBlanco.has(k)) matBlanco.set(k, new THREE.MeshStandardMaterial({ color: k === "t" ? 0xcfe0e6 : BLANCO, roughness: 0.9, side: THREE.DoubleSide, transparent: k === "t", opacity: k === "t" ? 0.35 : 1, depthWrite: k !== "t" }));
    return matBlanco.get(k);
  }

  api.StreamAllMeshes(modelID, m => {
    const eid = m.expressID;
    let clase = api.GetNameFromTypeCode(api.GetLineType(modelID, eid));
    // Revit exporta las fundaciones "Footing-Rectangular" como losas: se reconocen como fundaciones
    const nombreEl = (api.GetLine(modelID, eid).Name || {}).value || "";
    if (clase === "IfcSlab" && /^Footing/i.test(nombreEl)) clase = "IfcFooting";
    claseDe.set(eid, clase);
    for (let i = 0; i < m.geometries.size(); i++) {
      const pg = m.geometries.get(i);
      const g = api.GetGeometry(modelID, pg.geometryExpressID);
      const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
      const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
      for (let a = 0, b = 0; a < v.length; a += 6, b += 3) {
        pos[b] = v[a]; pos[b + 1] = v[a + 1]; pos[b + 2] = v[a + 2];
        nor[b] = v[a + 3]; nor[b + 1] = v[a + 4]; nor[b + 2] = v[a + 5];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(ix), 1));
      matrix.fromArray(pg.flatTransformation);
      geo.applyMatrix4(matrix);
      const mc = materialColor(pg.color);
      const mesh = new THREE.Mesh(geo, materialBlanco(pg.color.w));
      mesh.userData = { eid, clase, nombre: nombreEl, matColor: mc, matBlanco: materialBlanco(pg.color.w) };
      // Aristas finas para leer el volumen, como en un dibujo de arquitectura
      const aristas = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), matAristas);
      aristas.raycast = () => {};
      mesh.add(aristas);
      modelo.add(mesh);
      if (!porElemento.has(eid)) porElemento.set(eid, []);
      porElemento.get(eid).push(mesh);
      g.delete();
    }
  });

  // Elementos que se esconden con "Ocultar cubierta": cubierta, piso SIP superior, cielo, luminarias y árbol
  modelo.children.forEach(m => {
    const { clase, nombre } = m.userData;
    m.geometry.computeBoundingBox();
    m.userData.techo = clase === "IfcRoof" || clase === "IfcCovering" || clase === "IfcLightFixture" ||
      /cubierta/i.test(nombre) || /tree|árbol|arbol/i.test(nombre) || // el árbol del patio central también se oculta
      (clase === "IfcSlab" && /SIP/i.test(nombre) && m.geometry.boundingBox.min.y > 5);
  });

  // Nivel de cada elemento (contención espacial)
  const nivelDe = new Map();
  const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < rels.size(); i++) {
    const r = api.GetLine(modelID, rels.get(i));
    const est = api.GetLine(modelID, r.RelatingStructure.value);
    const nombre = est && est.Name ? est.Name.value : "";
    (r.RelatedElements || []).forEach(o => nivelDe.set(o.value, nombre));
  }

  // ---------- Encuadre y vistas ----------
  const caja = new THREE.Box3(), centro = new THREE.Vector3(), tam = new THREE.Vector3();
  function medir() {
    caja.makeEmpty();
    modelo.children.forEach(m => { if (m.visible && m.userData.clase !== "IfcGeographicElement") caja.expandByObject(m); });
    if (caja.isEmpty()) caja.setFromObject(modelo);
    caja.getCenter(centro); caja.getSize(tam);
  }
  let anim = null;
  function irA(dir, inmediato) {
    medir();
    const radio = tam.length() * 0.5;
    const dist = radio / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
    const d = dir.clone().normalize();
    if (Math.abs(d.y) > 0.999) d.z += 0.0015; // evita el bloqueo de la vista superior
    const destino = centro.clone().add(d.normalize().multiplyScalar(dist));
    if (inmediato) { camera.position.copy(destino); controls.target.copy(centro); controls.update(); return; }
    anim = { t0: performance.now(), p0: camera.position.clone(), q0: controls.target.clone(), p1: destino, q1: centro.clone() };
  }
  const VISTAS = {
    iso: new THREE.Vector3(1, 0.85, 1.15), planta: new THREE.Vector3(0, 1, 0),
    frente: new THREE.Vector3(0, 0.12, 1), lateral: new THREE.Vector3(1, 0.12, 0)
  };

  // ---------- Opciones de visualización ----------
  let conColor = false;
  function aplicarMateriales() {
    modelo.children.forEach(m => { m.material = m.userData.resaltado ? matResalte : (conColor ? m.userData.matColor : m.userData.matBlanco); });
  }
  // Visibilidad según los botones. "Estructura" replica la vista de Revit "ISO - Estructura (Vigas y Pilares)":
  // armazón estructural (vigas), pilares estructurales y fundaciones.
  const ESTRUCTURA = new Set(["IfcBeam", "IfcColumn", "IfcFooting"]);
  const vis = { cubierta: true, terreno: false, estructura: false };
  function actualizarVisibilidad() {
    modelo.children.forEach(m => {
      const c = m.userData.clase;
      let v = true;
      if (c === "IfcGeographicElement") v = vis.terreno;
      else if (vis.estructura) v = ESTRUCTURA.has(c);
      else if (m.userData.techo) v = vis.cubierta;
      m.visible = v;
    });
  }
  actualizarVisibilidad(); // el terreno parte oculto

  // ---------- Ficha al hacer clic ----------
  const matResalte = new THREE.MeshStandardMaterial({ color: 0xc9a46a, emissive: 0x3a2a10, roughness: 0.6, side: THREE.DoubleSide });
  const resaltado = { eid: null };
  const ficha = document.createElement("div");
  ficha.className = "v3d-ficha";
  ficha.hidden = true;
  contenedor.appendChild(ficha);
  function limpiarResalte() {
    if (resaltado.eid != null) (porElemento.get(resaltado.eid) || []).forEach(m => { m.userData.resaltado = false; m.material = conColor ? m.userData.matColor : m.userData.matBlanco; });
    resaltado.eid = null;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  const valor = p => {
    const v = p.NominalValue || p.LengthValue || p.AreaValue || p.VolumeValue || p.CountValue;
    if (!v) return null;
    let x = v.value; if (typeof x === "number") x = Math.round(x * 1000) / 1000;
    if (x === true || x === "T") x = "Sí"; if (x === false || x === "F") x = "No";
    return String(x);
  };
  async function mostrarFicha(eid) {
    limpiarResalte();
    resaltado.eid = eid;
    (porElemento.get(eid) || []).forEach(m => { m.userData.resaltado = true; m.material = matResalte; });
    const l = api.GetLine(modelID, eid);
    const nombre = (l.Name && l.Name.value) || "";
    const partes = nombre.split(":");
    const titulo = partes.length > 1 ? partes[1] : nombre;
    const clase = claseDe.get(eid);
    const filas = [["Categoría", CLASES[clase] || clase.replace(/^Ifc/, "")], ["Familia / tipo", partes[0] || "—"], ["Nivel", nivelDe.get(eid) || "—"]];
    try {
      const mats = await api.properties.getMaterialsProperties(modelID, eid, true, true);
      const nombres = new Set();
      const recorrer = o => { if (!o || typeof o !== "object") return; if (o.type === WebIFC.IFCMATERIAL && o.Name) nombres.add(o.Name.value); Object.values(o).forEach(v => { if (v && typeof v === "object") recorrer(v); }); };
      recorrer(mats);
      if (nombres.size) filas.push(["Material", [...nombres].slice(0, 4).join(" · ")]);
    } catch (e) { /* sin materiales */ }
    try {
      const psets = await api.properties.getPropertySets(modelID, eid, true, true);
      psets.forEach(ps => (ps.HasProperties || ps.Quantities || []).forEach(p => {
        const v = valor(p); if (v != null && p.Name && filas.length < 14) filas.push([p.Name.value, v]);
      }));
    } catch (e) { /* sin propiedades */ }
    ficha.innerHTML = '<button type="button" class="v3d-ficha-x" aria-label="Cerrar ficha">×</button>' +
      '<div class="v3d-ficha-t">' + esc(titulo || CLASES[clase] || clase) + '</div>' +
      '<dl>' + filas.map(f => '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>').join("") + '</dl>';
    ficha.hidden = false;
    ficha.querySelector(".v3d-ficha-x").onclick = () => { ficha.hidden = true; limpiarResalte(); };
  }
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let abajo = null;
  renderer.domElement.addEventListener("pointerdown", e => { abajo = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointerup", e => {
    if (!abajo || e.button !== 0 || Math.hypot(e.clientX - abajo.x, e.clientY - abajo.y) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(modelo.children.filter(m => m.visible), false)[0];
    if (hit) mostrarFicha(hit.object.userData.eid); else { ficha.hidden = true; limpiarResalte(); }
  });

  // ---------- Cubo de navegación ----------
  const cuboWrap = document.createElement("div");
  cuboWrap.className = "v3d-cubo";
  contenedor.appendChild(cuboWrap);
  const cuboR = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  cuboR.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  cuboR.setSize(96, 96);
  cuboWrap.appendChild(cuboR.domElement);
  const cuboScene = new THREE.Scene(), cuboCam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  function cara(texto) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d");
    x.fillStyle = "#f3f0ea"; x.fillRect(0, 0, 128, 128);
    x.strokeStyle = "#392f2b"; x.lineWidth = 4; x.strokeRect(2, 2, 124, 124);
    x.fillStyle = "#392f2b"; x.font = "700 17px Urbanist, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(texto, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: t });
  }
  // Orden de caras de BoxGeometry: +x, -x, +y, -y, +z, -z
  const caras = [["DERECHA", new THREE.Vector3(1, 0.12, 0)], ["IZQUIERDA", new THREE.Vector3(-1, 0.12, 0)], ["SUPERIOR", new THREE.Vector3(0, 1, 0)], ["INFERIOR", new THREE.Vector3(0, -1, 0)], ["FRONTAL", new THREE.Vector3(0, 0.12, 1)], ["POSTERIOR", new THREE.Vector3(0, 0.12, -1)]];
  const cubo = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), caras.map(c => cara(c[0])));
  cuboScene.add(cubo);
  cuboR.domElement.addEventListener("click", e => {
    const r = cuboR.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, cuboCam);
    const hit = ray.intersectObject(cubo)[0];
    if (hit) irA(caras[hit.face.materialIndex][1]);
  });
  const cuboBtns = document.createElement("div");
  cuboBtns.className = "v3d-cubo-btns";
  cuboBtns.innerHTML = '<button type="button" data-g="-1" title="Girar a la izquierda" aria-label="Girar a la izquierda">⟲</button><button type="button" data-g="0" title="Vista inicial" aria-label="Vista inicial">⌂</button><button type="button" data-g="1" title="Girar a la derecha" aria-label="Girar a la derecha">⟳</button>';
  cuboWrap.appendChild(cuboBtns);
  cuboBtns.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const g = +b.dataset.g;
    if (!g) return irA(VISTAS.iso);
    const d = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), g * Math.PI / 4);
    irA(d);
  });

  // ---------- Bucle ----------
  function ajustar() {
    const w = contenedor.clientWidth, h = contenedor.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(ajustar).observe(contenedor);
  ajustar();
  irA(VISTAS.iso, true);
  (function bucle(now) {
    if (anim) {
      const u = Math.min(1, (now - anim.t0) / 650), k = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      camera.position.lerpVectors(anim.p0, anim.p1, k); controls.target.lerpVectors(anim.q0, anim.q1, k);
      if (u >= 1) anim = null;
    }
    controls.update();
    renderer.render(scene, camera);
    const dir = camera.position.clone().sub(controls.target).normalize();
    cuboCam.position.copy(dir.multiplyScalar(3.4)); cuboCam.up.copy(camera.up); cuboCam.lookAt(0, 0, 0);
    cuboR.render(cuboScene, cuboCam);
    requestAnimationFrame(bucle);
  })(performance.now());

  estado("");
  return {
    vista: n => irA(VISTAS[n]),
    cubierta: ver => { vis.cubierta = ver; actualizarVisibilidad(); },
    estructura: activo => { vis.estructura = activo; actualizarVisibilidad(); },
    color: activo => { conColor = activo; aplicarMateriales(); },
    terreno: ver => { vis.terreno = ver; actualizarVisibilidad(); },
    resumen: () => ({ elementos: porElemento.size })
  };
}
