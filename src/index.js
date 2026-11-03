// Agent vocal Trinocle Film, sur Cloudflare Workers.
// Parcours d'un échange : voix → texte (Whisper) → réponse (Mistral) → voix (MeloTTS).
// La réponse part phrase par phrase, pour que l'on entende la première sans attendre la dernière.
// Aucune donnée n'est stockée par ce programme, et aucun contenu n'est écrit dans les journaux.

import { ACCUEIL, INDICE_TRANSCRIPTION, INVITE_SYSTEME, NOMS_PROPRES, PRONONCIATION } from "./connaissances.js";
import {
  calculerConsommation,
  choisirLangue,
  DecoupeurPhrases,
  detecterIntention,
  devinerLangue,
  dureeEstimee,
  dureeMp3,
  estInvention,
  LANGUES,
  langueValide,
  lireFluxModele,
  nettoyerHistorique,
  pourLaVoix,
} from "./voix.js";

const MODELES = {
  transcription: "@cf/openai/whisper-large-v3-turbo",
  reponse: "@cf/mistralai/mistral-small-3.1-24b-instruct",
  reponseSecours: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  voix: "@cf/myshell-ai/melotts",
};

const LIMITES = {
  audioBase64: 1_200_000, // environ 25 secondes de voix
  texte: 500,
  texteVoix: 300,
  jetonsReponse: 200,
  toursParMinute: 20,
};

const PHRASES_INCIDENT = {
  fr: {
    quota:
      "Je ne peux plus répondre pour aujourd'hui, car j'ai atteint ma limite quotidienne. Vous pouvez réserver un rendez-vous avec Torino avec le bouton à l'écran.",
    technique:
      "Je n'ai pas réussi à répondre à cause d'un problème technique. Réessayez, ou réservez un rendez-vous avec Torino avec le bouton à l'écran.",
  },
  en: {
    quota: "I can't answer any more today, because I've reached my daily limit. You can book a meeting with Torino using the button on screen.",
    technique: "I couldn't answer because of a technical problem. Please try again, or book a meeting with Torino using the button on screen.",
  },
  zh: {
    quota: "今天我已达到每日上限，无法继续回答。您可以点击屏幕上的按钮，与Torino预约会面。",
    technique: "由于技术问题，我没能回答。请再试一次，或点击屏幕上的按钮与Torino预约会面。",
  },
};

const enJson = (donnees, statut = 200, entetes = {}) =>
  new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { "content-type": "application/json; charset=utf-8", ...entetes },
  });

const typeIncident = (erreur) => (/4006|neurons/i.test(String(erreur?.message ?? erreur)) ? "quota" : "technique");

function memeOrigine(requete) {
  const origine = requete.headers.get("Origin");
  if (!origine) return true;
  try {
    return new URL(origine).host === new URL(requete.url).host;
  } catch {
    return false;
  }
}

// Frein simple contre les abus : compté en mémoire, oublié au bout d'une minute.
const compteurs = new Map();
function tropDeDemandes(requete) {
  const adresse = requete.headers.get("CF-Connecting-IP") ?? "inconnue";
  const maintenant = Date.now();
  const entree = compteurs.get(adresse);
  if (!entree || maintenant - entree.debut > 60_000) {
    if (compteurs.size > 5000) compteurs.clear();
    compteurs.set(adresse, { debut: maintenant, nombre: 1 });
    return false;
  }
  entree.nombre += 1;
  return entree.nombre > LIMITES.toursParMinute;
}

function versBase64(octets) {
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) {
    binaire += String.fromCharCode.apply(null, octets.subarray(i, i + 0x8000));
  }
  return btoa(binaire);
}

function depuisBase64(texte) {
  const binaire = atob(texte);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
  return octets;
}

// Fabrique la voix d'une phrase. Renvoie le son et sa durée, qui sert à compter la consommation.
async function synthetiser(env, texte, langue = "fr") {
  const prompt = pourLaVoix(texte, PRONONCIATION[langue] ?? [], langue);
  if (!prompt) return null;
  const resultat = await env.AI.run(MODELES.voix, { prompt, lang: langue });
  let octets = null;
  if (typeof resultat?.audio === "string") octets = depuisBase64(resultat.audio);
  else if (resultat instanceof ReadableStream) octets = new Uint8Array(await new Response(resultat).arrayBuffer());
  else if (resultat instanceof ArrayBuffer) octets = new Uint8Array(resultat);
  else if (resultat instanceof Uint8Array) octets = resultat;
  if (!octets?.length) return null;
  const audio = typeof resultat?.audio === "string" ? resultat.audio : versBase64(octets);
  return { audio, secondes: dureeMp3(octets) ?? dureeEstimee(prompt) };
}

// Durée de la question, lue dans le WAV envoyé par le navigateur (16 000 échantillons de 2 octets par seconde).
const secondesWav = (base64) => Math.max(0, (base64.length * 3) / 4 - 44) / 32000;

// Voix vers texte. Whisper devine la langue ; s'il hésite, on refait dans la langue de la conversation.
async function transcrire(env, audio, precedente, conso) {
  const options = { audio, task: "transcribe", vad_filter: true };
  const premier = await env.AI.run(MODELES.transcription, { ...options, initial_prompt: NOMS_PROPRES });
  conso.secondesEcoutees += secondesWav(audio);
  const texte = (premier?.text ?? "").trim();
  const info = premier?.transcription_info ?? {};
  // Sans langue renvoyée par Whisper, on la devine dans le texte plutôt que de payer un second passage.
  if (!info.language) return { texte, langue: devinerLangue(texte, precedente), indice: NOMS_PROPRES };
  const choix = choisirLangue(info.language, info.language_probability, precedente);
  if (!choix.refaire) return { texte, langue: choix.langue, indice: NOMS_PROPRES };

  const indice = choix.langue === "fr" ? INDICE_TRANSCRIPTION : NOMS_PROPRES;
  const second = await env.AI.run(MODELES.transcription, { ...options, language: choix.langue, initial_prompt: indice });
  conso.secondesEcoutees += secondesWav(audio);
  return { texte: (second?.text ?? "").trim(), langue: choix.langue, indice };
}

async function appelerModele(env, messages) {
  const options = { messages, stream: true, max_tokens: LIMITES.jetonsReponse, temperature: 0.3 };
  try {
    return { flux: await env.AI.run(MODELES.reponse, options), modele: MODELES.reponse };
  } catch (erreur) {
    if (typeIncident(erreur) === "quota") throw erreur;
    return { flux: await env.AI.run(MODELES.reponseSecours, options), modele: MODELES.reponseSecours };
  }
}

const consigneLangue = (langue) =>
  `\n\nLANGUE DE RÉPONSE\nRéponds uniquement ${LANGUES[langue].consigne}, même si la base ci-dessus est en français. Garde les noms Trinocle Film et Torino tels quels.`;

// Environ 3,5 caractères par jeton : ne sert que si Cloudflare ne renvoie pas le compte exact.
const jetonsEstimes = (texte) => Math.ceil(String(texte).length / 3.5);

async function derouler(corps, env, envoyer, estParti, suivi) {
  const mesures = {};
  const conso = { secondesEcoutees: 0, secondesDites: 0, jetonsLus: 0, jetonsEcrits: 0, modele: null, estime: false };
  const debut = Date.now();
  const precedente = langueValide(corps.langue);
  let question = typeof corps.texte === "string" ? corps.texte.trim().slice(0, LIMITES.texte) : "";
  let langue;

  if (question) {
    langue = devinerLangue(question, precedente);
  } else {
    const transcrit = await transcrire(env, corps.audio, precedente, conso);
    mesures.transcription = Date.now() - debut;
    question = transcrit.texte;
    langue = transcrit.langue;
    if (estInvention(question, transcrit.indice)) {
      await envoyer({ t: "rien", mesures: { ...mesures, conso: calculerConsommation(conso) } });
      return;
    }
  }
  suivi.langue = langue;

  await envoyer({ t: "transcription", texte: question, langue });
  if (corps.mode === "transcription") {
    await envoyer({ t: "fin", mesures: { ...mesures, conso: calculerConsommation(conso) } });
    return;
  }

  let intention = detecterIntention(question);
  if (intention) await envoyer({ t: "intention", intention });

  const avecVoix = corps.voix !== "navigateur";
  const debutReponse = Date.now();
  const messages = [
    { role: "system", content: INVITE_SYSTEME + consigneLangue(langue) },
    ...nettoyerHistorique(corps.historique),
    { role: "user", content: question },
  ];
  const { flux, modele } = await appelerModele(env, messages);
  conso.modele = modele;

  // Les voix se fabriquent en parallèle mais partent toujours dans l'ordre des phrases.
  const decoupeur = new DecoupeurPhrases();
  let reponseComplete = "";
  let file = Promise.resolve();
  const planifier = (phrase) => {
    const voix = avecVoix ? synthetiser(env, phrase, langue).catch(() => null) : Promise.resolve(null);
    file = file.then(async () => {
      const son = await voix;
      if (son) conso.secondesDites += son.secondes;
      mesures.premiereVoix ??= Date.now() - debutReponse;
      await envoyer({ t: "phrase", texte: phrase, audio: son?.audio ?? null });
    });
  };

  const infos = {};
  for await (const morceau of lireFluxModele(flux, infos)) {
    if (estParti()) break; // Personne n'écoute plus : on arrête de consommer le quota.
    mesures.premierMot ??= Date.now() - debutReponse;
    reponseComplete += morceau;
    for (const phrase of decoupeur.ajouter(morceau)) planifier(phrase);
  }
  const reste = decoupeur.finir();
  if (reste) planifier(reste);
  await file;

  if (!intention && /rendez-vous|appointment|meeting|预约|會面|会面/i.test(reponseComplete)) {
    intention = "rdv";
    await envoyer({ t: "intention", intention });
  }

  conso.jetonsLus = infos.usage?.prompt_tokens ?? jetonsEstimes(messages.map((m) => m.content).join(" "));
  conso.jetonsEcrits = infos.usage?.completion_tokens ?? jetonsEstimes(reponseComplete);
  conso.estime = !infos.usage;
  mesures.total = Date.now() - debut;
  await envoyer({ t: "fin", mesures: { ...mesures, conso: calculerConsommation(conso) } });
}

function tour(corps, env, ctx) {
  const { readable, writable } = new TransformStream();
  const ecrivain = writable.getWriter();
  const encodeur = new TextEncoder();
  const CLIENT_PARTI = Symbol("client parti");
  let parti = false;
  const envoyer = async (objet) => {
    if (parti) throw CLIENT_PARTI;
    try {
      await ecrivain.write(encodeur.encode(`${JSON.stringify(objet)}\n`));
    } catch {
      parti = true; // La personne a interrompu l'assistant ou fermé la page.
      throw CLIENT_PARTI;
    }
  };

  const suivi = { langue: langueValide(corps.langue) ?? "fr" };
  ctx.waitUntil(
    derouler(corps, env, envoyer, () => parti, suivi)
      .catch(async (erreur) => {
        if (erreur === CLIENT_PARTI) return;
        const code = typeIncident(erreur);
        console.error(`Tour interrompu (${code}) : ${String(erreur?.message ?? erreur).slice(0, 160)}`);
        await envoyer({
          t: "erreur",
          code,
          langue: suivi.langue,
          texte: PHRASES_INCIDENT[suivi.langue][code],
          detail: String(erreur?.message ?? erreur).slice(0, 200),
        }).catch(() => {});
      })
      .finally(() => ecrivain.close().catch(() => {})),
  );

  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform" },
  });
}

// L'introduction est toujours la même : on ne la fabrique qu'une fois, puis on la garde en cache.
async function accueil(requete, env, ctx) {
  const empreinte = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(ACCUEIL.join("|")));
  const version = [...new Uint8Array(empreinte).slice(0, 6)].map((o) => o.toString(16).padStart(2, "0")).join("");
  const cle = new Request(new URL(`/api/accueil?v=${version}`, requete.url));
  const cache = globalThis.caches?.default;
  const enCache = cache ? await cache.match(cle).catch(() => null) : null;
  if (enCache) return enCache;

  const phrases = await Promise.all(
    ACCUEIL.map(async (texte) => ({ texte, audio: (await synthetiser(env, texte, "fr").catch(() => null))?.audio ?? null })),
  );
  const complet = phrases.every((p) => p.audio);
  const reponse = enJson({ phrases }, 200, {
    "cache-control": complet ? "public, max-age=86400" : "no-store",
  });
  if (complet && cache) ctx.waitUntil(cache.put(cle, reponse.clone()).catch(() => {}));
  return reponse;
}

async function lireCorps(requete) {
  try {
    return await requete.json();
  } catch {
    return null;
  }
}

// Silence de 0,6 s au format attendu par Whisper : sert à vérifier que le modèle répond.
function silenceWav() {
  const echantillons = 9600;
  const octets = new Uint8Array(44 + echantillons * 2);
  const vue = new DataView(octets.buffer);
  const texte = (d, t) => [...t].forEach((c, i) => vue.setUint8(d + i, c.charCodeAt(0)));
  texte(0, "RIFF");
  vue.setUint32(4, 36 + echantillons * 2, true);
  texte(8, "WAVEfmt ");
  vue.setUint32(16, 16, true);
  vue.setUint16(20, 1, true);
  vue.setUint16(22, 1, true);
  vue.setUint32(24, 16000, true);
  vue.setUint32(28, 32000, true);
  vue.setUint16(32, 2, true);
  vue.setUint16(34, 16, true);
  texte(36, "data");
  vue.setUint32(40, echantillons * 2, true);
  let binaire = "";
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire);
}

// Essaie chaque modèle une fois, avec le plus petit appel possible, et dit lequel échoue et pourquoi.
async function diagnostic(env) {
  const etapes = [
    ["Voix vers texte", () => env.AI.run(MODELES.transcription, { audio: silenceWav(), task: "transcribe" })],
    [
      "Réponse",
      () => env.AI.run(MODELES.reponse, { messages: [{ role: "user", content: "Dis bonjour." }], max_tokens: 5 }),
    ],
    ["Voix française", () => env.AI.run(MODELES.voix, { prompt: "Bonjour.", lang: "fr" })],
    ["Voix anglaise", () => env.AI.run(MODELES.voix, { prompt: "Hello.", lang: "en" })],
    ["Voix chinoise", () => env.AI.run(MODELES.voix, { prompt: "你好。", lang: "zh" })],
  ];
  const resultats = [];
  for (const [nom, appel] of etapes) {
    const debut = Date.now();
    try {
      await appel();
      resultats.push({ nom, ok: true, ms: Date.now() - debut });
    } catch (erreur) {
      resultats.push({ nom, ok: false, ms: Date.now() - debut, detail: String(erreur?.message ?? erreur).slice(0, 200) });
    }
  }
  return resultats;
}

export default {
  async fetch(requete, env, ctx) {
    const { pathname } = new URL(requete.url);

    if (pathname === "/api/accueil" && requete.method === "GET") return accueil(requete, env, ctx);

    if (pathname === "/api/diagnostic") {
      if (requete.method !== "POST") return enJson({ erreur: "Méthode non acceptée." }, 405);
      if (!memeOrigine(requete)) return enJson({ erreur: "Origine refusée." }, 403);
      if (tropDeDemandes(requete)) return enJson({ erreur: "Trop de demandes, réessayez dans une minute." }, 429);
      return enJson({ etapes: await diagnostic(env) });
    }

    if (pathname === "/api/tour" || pathname === "/api/voix") {
      if (requete.method !== "POST") return enJson({ erreur: "Méthode non acceptée." }, 405);
      if (!memeOrigine(requete)) return enJson({ erreur: "Origine refusée." }, 403);
      if (tropDeDemandes(requete)) return enJson({ erreur: "Trop de demandes, réessayez dans une minute." }, 429);

      const corps = await lireCorps(requete);
      if (!corps) return enJson({ erreur: "Demande illisible." }, 400);

      if (pathname === "/api/voix") {
        const texte = typeof corps.texte === "string" ? corps.texte.trim().slice(0, LIMITES.texteVoix) : "";
        if (!texte) return enJson({ erreur: "Texte manquant." }, 400);
        const langue = langueValide(corps.langue) ?? devinerLangue(texte);
        const debut = Date.now();
        try {
          const son = await synthetiser(env, texte, langue);
          if (!son) throw new Error("Aucun son reçu.");
          return enJson({
            audio: son.audio,
            langue,
            duree: Date.now() - debut,
            prononce: pourLaVoix(texte, PRONONCIATION[langue], langue),
            conso: calculerConsommation({ secondesDites: son.secondes }),
          });
        } catch (erreur) {
          return enJson(
            { erreur: PHRASES_INCIDENT.fr[typeIncident(erreur)], detail: String(erreur?.message ?? erreur).slice(0, 200) },
            502,
          );
        }
      }

      const audioValide =
        typeof corps.audio === "string" && corps.audio.length > 0 && corps.audio.length <= LIMITES.audioBase64;
      const texteValide = typeof corps.texte === "string" && corps.texte.trim() !== "";
      if (!audioValide && !texteValide) return enJson({ erreur: "Ni voix ni texte reçus." }, 400);
      return tour(corps, env, ctx);
    }

    return enJson({ erreur: "Page introuvable." }, 404);
  },
};
