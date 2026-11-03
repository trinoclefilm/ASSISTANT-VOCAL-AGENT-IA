// La tourelle à trois objectifs : un par état de l'assistant (écoute, réflexion, parole).
// Chaque objectif a un diaphragme à sept lames, qui s'ouvre avec le volume de la voix.

const NS = "http://www.w3.org/2000/svg";
const LAMES = 7;
const RAYON_VERRE = 54;
const ETATS = [
  { cle: "ecoute", gravure: "À L'ÉCOUTE" },
  { cle: "reflexion", gravure: "RÉFLEXION" },
  { cle: "parole", gravure: "PAROLE" },
];
const OUVERT = 44;
const FERME = 13;

function el(nom, attributs = {}, parent) {
  const n = document.createElementNS(NS, nom);
  for (const [k, v] of Object.entries(attributs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

function construireObjectif(parent, etat, indice) {
  const g = el("g", { transform: `rotate(${indice * 120}) translate(0 -92)` }, parent);
  el("circle", { r: 78, fill: "url(#fut)" }, g);
  el("circle", { r: 77, fill: "none", stroke: "#0F1518", "stroke-width": 1.5 }, g);
  el("circle", { r: 60, fill: "#171F22" }, g);

  const arc = el("path", { id: `arc-${etat.cle}`, d: "M -68 0 A 68 68 0 0 1 68 0", fill: "none" }, g);
  arc.setAttribute("aria-hidden", "true");
  const texte = el("text", { class: "gravure", "text-anchor": "middle" }, g);
  const chemin = el("textPath", { href: `#arc-${etat.cle}`, startOffset: "50%" }, texte);
  chemin.textContent = etat.gravure;

  const verre = el("g", { "clip-path": "url(#verre)" }, g);
  el("circle", { r: RAYON_VERRE, fill: "url(#traitement)" }, verre);
  const lumiere = el("circle", { r: RAYON_VERRE, fill: "url(#tungstene)", opacity: 0 }, verre);
  const lames = [];
  for (let i = 0; i < LAMES; i += 1) {
    lames.push(
      el("rect", { x: -74, y: -150, width: 148, height: 150, fill: "url(#lame)", stroke: "#39454A", "stroke-width": 0.8 }, verre),
    );
  }
  el("path", { d: "M -38 -18 A 42 42 0 0 1 -12 -40", fill: "none", stroke: "#F4F1E8", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.16 }, verre);
  el("circle", { r: RAYON_VERRE, fill: "none", stroke: "#0F1518", "stroke-width": 3 }, g);

  return { g, lames, lumiere, rayon: FERME };
}

function reglerDiaphragme(objectif, rayon) {
  objectif.rayon = rayon;
  objectif.lames.forEach((lame, i) => {
    lame.setAttribute("transform", `rotate(${(i * 360) / LAMES}) translate(0 ${(-rayon).toFixed(2)})`);
  });
}

export function creerTourelle(svg) {
  const calme = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const defs = el("defs", {}, svg);
  defs.innerHTML = `
    <radialGradient id="disque" cx="38%" cy="30%" r="85%">
      <stop offset="0" stop-color="#5B686C"/><stop offset=".55" stop-color="#3C484C"/><stop offset="1" stop-color="#28333A"/>
    </radialGradient>
    <linearGradient id="fut" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#46535A"/><stop offset="1" stop-color="#20292D"/>
    </linearGradient>
    <linearGradient id="lame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1B2326"/><stop offset="1" stop-color="#2E393E"/>
    </linearGradient>
    <radialGradient id="traitement" cx="50%" cy="50%" r="55%">
      <stop offset="0" stop-color="#0C1114"/><stop offset=".34" stop-color="#16314A"/>
      <stop offset=".62" stop-color="#5A3F9E"/><stop offset=".84" stop-color="#2F9C8E"/><stop offset="1" stop-color="#C98A2E"/>
    </radialGradient>
    <radialGradient id="tungstene" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#FFE9B5"/><stop offset=".5" stop-color="#F2B544" stop-opacity=".9"/>
      <stop offset="1" stop-color="#F2B544" stop-opacity=".2"/>
    </radialGradient>
    <clipPath id="verre"><circle r="${RAYON_VERRE}"/></clipPath>`;

  const racine = el("g", { transform: "translate(200 200)" }, svg);
  el("circle", { r: 192, fill: "#141B1E" }, racine);
  el("circle", { r: 187, fill: "none", stroke: "#5B686C", "stroke-width": 9, "stroke-dasharray": "2.6 3.2" }, racine);
  el("circle", { r: 180, fill: "url(#disque)" }, racine);

  const plateau = el("g", {}, racine);
  const objectifs = ETATS.map((etat, i) => construireObjectif(plateau, etat, i));
  el("circle", { r: 13, fill: "#20292D", stroke: "#0F1518", "stroke-width": 1.5 }, plateau);
  el("line", { x1: -7, y1: 0, x2: 7, y2: 0, stroke: "#5B686C", "stroke-width": 2.4, "stroke-linecap": "round" }, plateau);

  // Le repère fixe : l'objectif placé dessous est celui qui travaille.
  el("path", { d: "M -11 -199 L 11 -199 L 0 -181 Z", fill: "#F2B544" }, racine);

  objectifs.forEach((o) => reglerDiaphragme(o, FERME));

  let indiceActif = 0;
  let angle = 0;
  let angleVise = 0;
  let vitesse = 0;
  let niveau = 0;
  let lireNiveau = () => 0;
  let phase = "repos";
  let boucleActive = false;
  let t0 = 0;

  function image(t) {
    if (!t0) t0 = t;
    const dt = Math.min(0.05, (t - t0) / 1000);
    t0 = t;

    // Rotation mécanique : un ressort un peu raide, avec un léger dépassement.
    if (calme) {
      angle = angleVise;
      vitesse = 0;
    } else {
      vitesse += (angleVise - angle) * 90 * dt;
      vitesse *= Math.exp(-11 * dt);
      angle += vitesse * dt;
      if (Math.abs(angleVise - angle) < 0.02 && Math.abs(vitesse) < 0.05) {
        angle = angleVise;
        vitesse = 0;
      }
    }
    plateau.setAttribute("transform", `rotate(${(-angle).toFixed(2)})`);

    const brut = lireNiveau();
    niveau += (brut - niveau) * (brut > niveau ? 0.5 : 0.14);
    const actif = objectifs[indiceActif];
    let cible = FERME;
    if (phase === "ecoute") cible = calme ? 26 : 15 + niveau * (OUVERT - 15);
    else if (phase === "parole") cible = calme ? 34 : 20 + niveau * (OUVERT - 20);
    else if (phase === "reflexion") cible = calme ? 22 : 22 + Math.sin(t / 420) * 6;
    else if (phase === "repos") cible = calme ? 30 : 28 + Math.sin(t / 1800) * 3;

    objectifs.forEach((o) => {
      const vise = o === actif ? cible : FERME;
      if (Math.abs(vise - o.rayon) > 0.05) reglerDiaphragme(o, o.rayon + (vise - o.rayon) * 0.25);
    });
    const lueur = phase === "parole" ? 0.25 + niveau * 0.75 : 0;
    actif.lumiere.setAttribute("opacity", lueur.toFixed(2));
    objectifs.forEach((o) => {
      if (o !== actif) o.lumiere.setAttribute("opacity", 0);
    });

    if (document.hidden) {
      boucleActive = false;
      t0 = 0;
      return;
    }
    requestAnimationFrame(image);
  }

  function relancer() {
    if (boucleActive) return;
    boucleActive = true;
    requestAnimationFrame(image);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) relancer();
  });
  relancer();

  return {
    regler(nouvellePhase, sourceNiveau) {
      phase = nouvellePhase;
      lireNiveau = sourceNiveau ?? (() => 0);
      const cle = { parole: 2, reflexion: 1 }[nouvellePhase] ?? 0;
      // Toujours dans le même sens, comme une vraie tourelle qu'on fait pivoter à la main.
      const pas = ((cle - indiceActif + 3) % 3) * 120;
      angleVise += pas;
      indiceActif = cle;
    },
  };
}
