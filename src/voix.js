// Outils de texte de l'agent : aucun appel réseau ici, tout est testable seul.

const UNITES = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze",
  "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf",
];
const DIZAINES = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];

function moinsDeCent(n) {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7 || d === 9) {
    const reste = n - d * 10 + 10;
    if (d === 7 && reste === 11) return "soixante et onze";
    return `${DIZAINES[d]}-${UNITES[reste]}`;
  }
  if (u === 0) return d === 8 ? "quatre-vingts" : DIZAINES[d];
  if (u === 1 && d !== 8) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

function moinsDeMille(n) {
  if (n < 100) return moinsDeCent(n);
  const c = Math.floor(n / 100);
  const r = n % 100;
  const tete = c === 1 ? "cent" : `${UNITES[c]} cent${r === 0 ? "s" : ""}`;
  return r === 0 ? tete : `${tete} ${moinsDeCent(r)}`;
}

export function nombreEnLettres(n) {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
  if (n < 1000) return moinsDeMille(n);
  if (n < 1e6) {
    const m = Math.floor(n / 1000);
    const r = n % 1000;
    const tete = m === 1 ? "mille" : `${moinsDeMille(m).replace(/cents$/, "cent").replace(/vingts$/, "vingt")} mille`;
    return r === 0 ? tete : `${tete} ${moinsDeMille(r)}`;
  }
  const m = Math.floor(n / 1e6);
  const r = n % 1e6;
  const tete = `${moinsDeMille(m)} million${m > 1 ? "s" : ""}`;
  return r === 0 ? tete : `${tete} ${nombreEnLettres(r)}`;
}

// Rend un texte prononçable : la voix ne doit jamais lire un symbole, un lien ou un chiffre.
export function pourLaVoix(texte, prononciation = []) {
  let t = String(texte)
    .replace(/https?:\/\/\S+|\b[\w.-]+\.(?:com|fr|io|so)\/\S*/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[*_#`~|>[\]{}]/g, " ");
  for (const [motif, remplacement] of prononciation) t = t.replace(motif, remplacement);
  t = t
    .replace(/(\d)[\s  ](?=\d{3}\b)/g, "$1")
    .replace(/\s*%/g, " pour cent")
    .replace(/\s*€/g, " euros")
    .replace(/\s*&\s*/g, " et ")
    .replace(/\b(\d+)[.,](\d+)\b/g, (_, a, b) => `${nombreEnLettres(+a)} virgule ${nombreEnLettres(+b)}`)
    .replace(/\d+/g, (d) => nombreEnLettres(Number(d)));
  return t.replace(/\s+/g, " ").trim();
}

// Whisper invente ces phrases quand il n'entend que du silence ou du bruit en français.
const INVENTIONS = [
  /sous[- ]?titr/i,
  /amara\.?org/i,
  /radio[- ]canada/i,
  /merci d['’]avoir regard/i,
  /abonnez[- ]vous/i,
  /^\W*(musique|applaudissements|rires)\W*$/i,
  /^[\s♪.…,!?-]*$/,
];

export function estInvention(texte, indice = "") {
  const t = String(texte ?? "").trim();
  if (t.length < 2) return true;
  if (INVENTIONS.some((m) => m.test(t))) return true;
  const plat = (s) => s.toLowerCase().replace(/\W+/g, "");
  return indice !== "" && plat(indice).includes(plat(t));
}

// Ce que la personne cherche. Sert à afficher le bon contenu et à faire réagir la vidéo.
const INTENTIONS = [
  ["rdv", /rendez[- ]?vous|\brdv\b|r[ée]server|me rappeler|vous appeler|prendre contact|parler [àa] (quelqu|torino)/i],
  ["prix", /\bprix\b|co[uû]te?|tarif|combien|budget|devis|\bcher\b/i],
  ["garantie", /marche pas|fonctionne pas|garanti|rembours|risque|retour sur invest|\br\.?o\.?i\b/i],
  ["deroule", /d[ée]lai|combien de temps|semaines?|[ée]tapes?|se passe|d[ée]roul|planning|tournage/i],
  ["exemples", /exemple|d[ée]mo|montrez|montrer|r[ée]f[ée]rence|voir (une|des|ce que)/i],
  ["automation", /automati|\bcrm\b|notion|claude|formulaire|e-?mails?/i],
  ["histoire", /histoire|qui [êe]tes|fondateur|torino|parcours/i],
];

export function detecterIntention(texte) {
  // « combien de temps » parle de délai, pas de prix.
  const t = String(texte).replace(/combien de temps/gi, "délai");
  return INTENTIONS.find(([, motif]) => motif.test(t))?.[0] ?? null;
}

const ABREVIATIONS = /(?:\b(?:M|Mme|Mlle|Dr|ex|cf|p|n)\.)$/;

// Coupe le texte en phrases au fil de l'eau, pour que la voix démarre sans attendre la fin.
export class DecoupeurPhrases {
  constructor({ minimum = 18, maximum = 180 } = {}) {
    this.tampon = "";
    this.minimum = minimum;
    this.maximum = maximum;
  }

  ajouter(morceau) {
    this.tampon += morceau;
    const phrases = [];
    let depart = 0;
    const fin = /[.!?…]+["»”’)]*\s+/g;
    let m;
    while ((m = fin.exec(this.tampon))) {
      const coupe = m.index + m[0].length;
      const candidat = this.tampon.slice(depart, coupe).trim();
      if (candidat.length < this.minimum || ABREVIATIONS.test(candidat)) continue;
      phrases.push(candidat);
      depart = coupe;
    }
    this.tampon = this.tampon.slice(depart);
    if (this.tampon.length > this.maximum) {
      const virgule = this.tampon.lastIndexOf(", ", this.maximum);
      if (virgule > this.minimum) {
        phrases.push(this.tampon.slice(0, virgule + 1).trim());
        this.tampon = this.tampon.slice(virgule + 2);
      }
    }
    return phrases;
  }

  finir() {
    const reste = this.tampon.trim();
    this.tampon = "";
    return reste;
  }
}

// Lit le flux texte d'un modèle Workers AI. Accepte les deux formats que Cloudflare renvoie.
export async function* lireFluxModele(flux) {
  const lecteur = flux.pipeThrough(new TextDecoderStream()).getReader();
  let tampon = "";
  try {
    for (;;) {
      const { value, done } = await lecteur.read();
      if (done) break;
      tampon += value;
      let saut;
      while ((saut = tampon.indexOf("\n")) >= 0) {
        const ligne = tampon.slice(0, saut).trim();
        tampon = tampon.slice(saut + 1);
        if (!ligne.startsWith("data:")) continue;
        const donnee = ligne.slice(5).trim();
        if (donnee === "[DONE]") return;
        let objet;
        try {
          objet = JSON.parse(donnee);
        } catch {
          continue;
        }
        const texte = objet.response ?? objet.choices?.[0]?.delta?.content;
        if (texte) yield texte;
      }
    }
  } finally {
    await lecteur.cancel().catch(() => {});
  }
}

// Ne garde de l'historique envoyé par le navigateur que ce qui est attendu, et pas plus.
// Les modèles exigent une alternance stricte : question, réponse, question, réponse.
export function nettoyerHistorique(historique) {
  if (!Array.isArray(historique)) return [];
  const propre = [];
  for (const m of historique) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) continue;
    const message = { role: m.role, content: m.content.slice(0, 600) };
    if (propre.at(-1)?.role === m.role) propre[propre.length - 1] = message;
    else if (propre.length > 0 || m.role === "user") propre.push(message);
  }
  if (propre.at(-1)?.role === "user") propre.pop();
  return propre.slice(-6);
}
