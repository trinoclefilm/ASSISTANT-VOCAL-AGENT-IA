// Outils de texte de l'agent : aucun appel réseau ici, tout est testable seul.

// Langues que l'agent comprend, écrit et dit. Pour en ajouter une, ajoute une ligne
// (MeloTTS sait aussi dire l'espagnol « es », le japonais « jp » et le coréen « kr »).
export const LANGUES = {
  fr: { consigne: "en français", navigateur: "fr-FR" },
  en: { consigne: "en anglais (in English)", navigateur: "en-US" },
  zh: { consigne: "en chinois mandarin, en caractères simplifiés (简体中文)", navigateur: "zh-CN" },
};
const ALIAS_LANGUE = { yue: "zh", "zh-cn": "zh", "zh-hans": "zh", "zh-tw": "zh", "fr-fr": "fr", "en-us": "en", "en-gb": "en" };

export function langueValide(code) {
  const brut = String(code ?? "").toLowerCase();
  const langue = ALIAS_LANGUE[brut] ?? brut;
  return Object.hasOwn(LANGUES, langue) ? langue : null;
}

// Whisper devine la langue parlée. On le suit s'il est sûr de lui ; sinon on garde la langue
// de la conversation et on refait la transcription dans cette langue.
export function choisirLangue(detectee, confiance, precedente) {
  const langue = langueValide(detectee);
  const avant = langueValide(precedente);
  if (langue && (langue === avant || !(confiance < 0.5))) return { langue, refaire: false };
  return { langue: avant ?? "fr", refaire: true };
}

const MOTS_FR = /\b(je|vous|nous|le|la|les|des|une?|est|et|que|qui|pour|avec|combien|comment|quoi|pourquoi|votre|vos|mon|mes|c'est|faites|avez|bonjour|merci|oui|non)\b/gi;
const MOTS_EN = /\b(i|you|we|the|is|are|and|that|what|how|why|who|for|with|your|my|can|do|does|it's|much|many|have|hello|hi|welcome|please|thanks|thank|yes|no)\b/gi;

// Pour une question écrite, sans Whisper : une estimation simple suffit.
export function devinerLangue(texte, precedente) {
  const t = String(texte ?? "");
  const han = (t.match(/\p{Script=Han}/gu) ?? []).length;
  const lettres = (t.match(/\p{L}/gu) ?? []).length;
  if (han > 0 && han >= lettres * 0.3) return "zh";
  const fr = (t.match(MOTS_FR) ?? []).length + (/[éèêàùçœ]/i.test(t) ? 2 : 0);
  const en = (t.match(MOTS_EN) ?? []).length;
  if (fr > en) return "fr";
  if (en > fr) return "en";
  return langueValide(precedente) ?? "fr";
}

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
export function pourLaVoix(texte, prononciation = [], langue = "fr") {
  let t = String(texte)
    .replace(/https?:\/\/\S+|\b[\w.-]+\.(?:com|fr|io|so)\/\S*/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[*_#`~|>[\]{}]/g, " ");
  for (const [motif, remplacement] of prononciation) t = t.replace(motif, remplacement);
  if (langue === "en") {
    t = t
      .replace(/(\d)[,\s](?=\d{3}\b)/g, "$1")
      .replace(/\s*%/g, " percent")
      .replace(/\s*€/g, " euros")
      .replace(/\s*&\s*/g, " and ");
    return t.replace(/\s+/g, " ").trim();
  }
  if (langue === "zh") {
    t = t
      .replace(/(\d+(?:[.,]\d+)?)\s*%/g, "百分之$1")
      .replace(/\s*€/g, "欧元")
      .replace(/\s*&\s*/g, "和");
    return t.replace(/\s+/g, " ").trim();
  }
  t = t
    .replace(/(\d)[\s  ](?=\d{3}\b)/g, "$1")
    .replace(/\s*%/g, " pour cent")
    .replace(/\s*€/g, " euros")
    .replace(/\s*&\s*/g, " et ")
    .replace(/\b(\d+)[.,](\d+)\b/g, (_, a, b) => `${nombreEnLettres(+a)} virgule ${nombreEnLettres(+b)}`)
    .replace(/\d+/g, (d) => nombreEnLettres(Number(d)));
  return t.replace(/\s+/g, " ").trim();
}

// Whisper invente ces phrases quand il n'entend que du silence ou du bruit.
const INVENTIONS = [
  /thank(s| you) for watching/i,
  /^\W*(thank you|thanks|you|bye)\W*$/i,
  /(like and )?subscribe/i,
  /subtitles? by/i,
  /字幕/,
  /点赞|點贊|订阅|訂閱|打赏|明镜|明鏡/,
  /(谢谢|謝謝|感谢|感謝)(大家)?(观看|觀看|收看)/,
  /ご視聴/,
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
  if (t.length < 2 && !/\p{Script=Han}/u.test(t)) return true;
  if (INVENTIONS.some((m) => m.test(t))) return true;
  // Whisper qui répète l'indice qu'on lui a donné : il n'a rien entendu.
  const plat = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return indice !== "" && plat(t) !== "" && plat(indice).includes(plat(t));
}

// Ce que la personne cherche. Sert à afficher le bon contenu et à faire réagir la vidéo.
// Chaque ligne couvre le français, l'anglais et le chinois.
const INTENTIONS = [
  [
    "rdv",
    /rendez[- ]?vous|\brdv\b|r[ée]server|me rappeler|vous appeler|prendre contact|parler [àa] (quelqu|torino)|appointment|book (a )?(call|meeting)|\bschedule\b|\bmeet(ing)?\b|talk to (torino|someone|a human)|call me|get in touch|预约|預約|约个时间|約個時間|见面|見面|通话|通話|联系|聯繫/i,
  ],
  [
    "prix",
    /\bprix\b|co[uû]te?|tarif|combien|budget|devis|\bcher\b|\bprices?\b|\bpricing\b|\bcosts?\b|how much|\bquote\b|expensive|\bfees?\b|价格|價格|多少钱|多少錢|费用|費用|报价|報價|预算|預算|太贵|很贵/i,
  ],
  [
    "garantie",
    /marche pas|fonctionne pas|garanti|rembours|risque|retour sur invest|\br\.?o\.?i\b|guarantee|refund|\brisks?\b|doesn'?t work|return on investment|保证|保證|退款|风险|風險|投资回报|投資回報|回报率/i,
  ],
  [
    "deroule",
    /d[ée]lai|semaines?|[ée]tapes?|se passe|d[ée]roul|planning|tournage|timeline|\bsteps?\b|\bprocess\b|\bweeks?\b|多久|多长时间|多長時間|流程|步骤|步驟|几周|幾週|周期|週期/i,
  ],
  ["exemples", /exemple|d[ée]mo|montrez|montrer|r[ée]f[ée]rence|voir (une|des|ce que)|examples?|show me|portfolio|case stud|案例|例子|示例|演示|作品/i],
  ["automation", /automati|\bcrm\b|notion|claude|formulaire|e-?mails?|automat|\bforms?\b|自动|自動|表单|表單|邮件|郵件/i],
  ["histoire", /histoire|qui [êe]tes|fondateur|torino|parcours|\bstory\b|who are you|founder|background|故事|你是谁|你是誰|创始人|創始人|经历|經歷/i],
];

export function detecterIntention(texte) {
  // « Combien de temps » parle de délai, pas de prix.
  const t = String(texte).replace(/combien de temps|how much time|how long/gi, "délai");
  return INTENTIONS.find(([, motif]) => motif.test(t))?.[0] ?? null;
}

const ABREVIATIONS = /(?:\b(?:M|Mme|Mlle|Dr|ex|cf|p|n|Mr|Mrs|Ms|e\.g|i\.e)\.)$/;
// Un caractère chinois porte autant de sens que trois lettres : on le compte triple.
const poids = (texte) => texte.length + (texte.match(/\p{Script=Han}/gu)?.length ?? 0) * 2;

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
    // Le point chinois n'est pas suivi d'une espace.
    const fin = /[.!?…]+["»”’)]*\s+|[。！？]+["」』”’）)]*/g;
    let m;
    while ((m = fin.exec(this.tampon))) {
      const coupe = m.index + m[0].length;
      const candidat = this.tampon.slice(depart, coupe).trim();
      if (poids(candidat) < this.minimum || ABREVIATIONS.test(candidat)) continue;
      phrases.push(candidat);
      depart = coupe;
    }
    this.tampon = this.tampon.slice(depart);
    if (poids(this.tampon) > this.maximum) {
      const zone = this.tampon.slice(0, this.maximum);
      const virgule = Math.max(zone.lastIndexOf(", "), zone.lastIndexOf("，"));
      if (virgule > 0 && poids(this.tampon.slice(0, virgule)) >= this.minimum) {
        phrases.push(this.tampon.slice(0, virgule + 1).trim());
        this.tampon = this.tampon.slice(virgule + 1).trimStart();
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
// Si Cloudflare indique le nombre de jetons consommés, il est rangé dans infos.usage.
export async function* lireFluxModele(flux, infos = {}) {
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
        if (objet.usage) infos.usage = objet.usage;
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

// Durée d'un fichier MP3, en secondes, en lisant l'en-tête de chaque trame.
// Sert à compter ce que coûte la voix, facturée à la minute de son produite.
const DEBITS_MP3 = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const FREQUENCES_MP3 = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function dureeMp3(octets) {
  let i = 0;
  if (octets.length > 10 && octets[0] === 0x49 && octets[1] === 0x44 && octets[2] === 0x33) {
    i = 10 + (((octets[6] & 0x7f) << 21) | ((octets[7] & 0x7f) << 14) | ((octets[8] & 0x7f) << 7) | (octets[9] & 0x7f));
  }
  let secondes = 0;
  let trames = 0;
  while (i + 4 <= octets.length) {
    if (octets[i] !== 0xff || (octets[i + 1] & 0xe0) !== 0xe0) {
      i += 1;
      continue;
    }
    const version = (octets[i + 1] >> 3) & 3; // 3 : MPEG-1, 2 : MPEG-2, 0 : MPEG-2.5
    const couche = (octets[i + 1] >> 1) & 3; // 1 : couche III
    const indiceDebit = octets[i + 2] >> 4;
    const indiceFrequence = (octets[i + 2] >> 2) & 3;
    if (version === 1 || couche !== 1 || indiceDebit === 0 || indiceDebit === 15 || indiceFrequence === 3) {
      i += 1;
      continue;
    }
    const debit = DEBITS_MP3[version === 3 ? 1 : 2][indiceDebit] * 1000;
    const frequence = FREQUENCES_MP3[version][indiceFrequence];
    const echantillons = version === 3 ? 1152 : 576;
    secondes += echantillons / frequence;
    trames += 1;
    i += Math.floor(((echantillons / 8) * debit) / frequence) + ((octets[i + 2] >> 1) & 1);
  }
  return trames > 0 ? secondes : null;
}

// Si le son est illisible : environ quatorze lettres par seconde, quatre caractères chinois et demi.
export function dureeEstimee(texte) {
  const han = (String(texte).match(/\p{Script=Han}/gu) ?? []).length;
  return han / 4.5 + (String(texte).length - han) / 14;
}

// Grille Workers AI, en neurones, relevée en novembre 2026.
// 10 000 neurones gratuits par jour, puis 0,011 $ les 1 000 avec le plan payant.
export const TARIFS = {
  transcriptionParSeconde: 46.63 / 60,
  voixParSeconde: 18.63 / 60,
  modeles: {
    "@cf/mistralai/mistral-small-3.1-24b-instruct": { entree: 31876 / 1e6, sortie: 50488 / 1e6 },
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { entree: 26668 / 1e6, sortie: 204805 / 1e6 },
  },
};

const arrondi = (n) => Math.round(n * 10) / 10;

// Résume ce qu'un échange a consommé, à partir des secondes de son et des jetons réels.
export function calculerConsommation({ secondesEcoutees = 0, secondesDites = 0, jetonsLus = 0, jetonsEcrits = 0, modele, estime = false }) {
  const tarif = TARIFS.modeles[modele] ?? { entree: 0, sortie: 0 };
  const neurones = {
    transcription: arrondi(secondesEcoutees * TARIFS.transcriptionParSeconde),
    reponse: arrondi(jetonsLus * tarif.entree + jetonsEcrits * tarif.sortie),
    voix: arrondi(secondesDites * TARIFS.voixParSeconde),
  };
  neurones.total = arrondi(neurones.transcription + neurones.reponse + neurones.voix);
  return {
    secondesEcoutees: arrondi(secondesEcoutees),
    secondesDites: arrondi(secondesDites),
    jetonsLus,
    jetonsEcrits,
    estime,
    neurones,
  };
}
