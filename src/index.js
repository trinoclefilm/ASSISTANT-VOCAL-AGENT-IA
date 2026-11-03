// Agent vocal Trinocle Film, sur Cloudflare Workers.
// Parcours d'un échange : voix → texte (Whisper) → réponse (Mistral) → voix (MeloTTS).
// La réponse part phrase par phrase, pour que l'on entende la première sans attendre la dernière.
// Aucune donnée n'est stockée par ce programme, et aucun contenu n'est écrit dans les journaux.

import { ACCUEIL, INDICE_TRANSCRIPTION, INVITE_SYSTEME, PRONONCIATION } from "./connaissances.js";
import {
  DecoupeurPhrases,
  detecterIntention,
  estInvention,
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
  quota:
    "Je ne peux plus répondre pour aujourd'hui, car j'ai atteint ma limite quotidienne. Vous pouvez réserver un rendez-vous avec Torino avec le bouton à l'écran.",
  technique:
    "Je n'ai pas réussi à répondre à cause d'un problème technique. Réessayez, ou réservez un rendez-vous avec Torino avec le bouton à l'écran.",
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

async function synthetiser(env, texte) {
  const prompt = pourLaVoix(texte, PRONONCIATION);
  if (!prompt) return null;
  const resultat = await env.AI.run(MODELES.voix, { prompt, lang: "fr" });
  if (typeof resultat?.audio === "string") return resultat.audio;
  if (resultat instanceof ReadableStream) return versBase64(new Uint8Array(await new Response(resultat).arrayBuffer()));
  if (resultat instanceof ArrayBuffer) return versBase64(new Uint8Array(resultat));
  if (resultat instanceof Uint8Array) return versBase64(resultat);
  return null;
}

async function appelerModele(env, messages) {
  const options = { messages, stream: true, max_tokens: LIMITES.jetonsReponse, temperature: 0.3 };
  try {
    return await env.AI.run(MODELES.reponse, options);
  } catch (erreur) {
    if (typeIncident(erreur) === "quota") throw erreur;
    return env.AI.run(MODELES.reponseSecours, options);
  }
}

async function derouler(corps, env, envoyer, estParti) {
  const mesures = {};
  const debut = Date.now();
  let question = typeof corps.texte === "string" ? corps.texte.trim().slice(0, LIMITES.texte) : "";

  if (!question) {
    const transcrit = await env.AI.run(MODELES.transcription, {
      audio: corps.audio,
      language: "fr",
      task: "transcribe",
      vad_filter: true,
      initial_prompt: INDICE_TRANSCRIPTION,
    });
    mesures.transcription = Date.now() - debut;
    question = (transcrit?.text ?? "").trim();
    if (estInvention(question, INDICE_TRANSCRIPTION)) {
      await envoyer({ t: "rien", mesures });
      return;
    }
  }

  await envoyer({ t: "transcription", texte: question });
  if (corps.mode === "transcription") {
    await envoyer({ t: "fin", mesures });
    return;
  }

  let intention = detecterIntention(question);
  if (intention) await envoyer({ t: "intention", intention });

  const avecVoix = corps.voix !== "navigateur";
  const debutReponse = Date.now();
  const flux = await appelerModele(env, [
    { role: "system", content: INVITE_SYSTEME },
    ...nettoyerHistorique(corps.historique),
    { role: "user", content: question },
  ]);

  // Les voix se fabriquent en parallèle mais partent toujours dans l'ordre des phrases.
  const decoupeur = new DecoupeurPhrases();
  let reponseComplete = "";
  let file = Promise.resolve();
  const planifier = (phrase) => {
    const voix = avecVoix ? synthetiser(env, phrase).catch(() => null) : Promise.resolve(null);
    file = file.then(async () => {
      const audio = await voix;
      mesures.premiereVoix ??= Date.now() - debutReponse;
      await envoyer({ t: "phrase", texte: phrase, audio });
    });
  };

  for await (const morceau of lireFluxModele(flux)) {
    if (estParti()) break; // Personne n'écoute plus : on arrête de consommer le quota.
    mesures.premierMot ??= Date.now() - debutReponse;
    reponseComplete += morceau;
    for (const phrase of decoupeur.ajouter(morceau)) planifier(phrase);
  }
  const reste = decoupeur.finir();
  if (reste) planifier(reste);
  await file;

  if (!intention && /rendez-vous/i.test(reponseComplete)) {
    intention = "rdv";
    await envoyer({ t: "intention", intention });
  }
  mesures.total = Date.now() - debut;
  await envoyer({ t: "fin", mesures });
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

  ctx.waitUntil(
    derouler(corps, env, envoyer, () => parti)
      .catch(async (erreur) => {
        if (erreur === CLIENT_PARTI) return;
        const code = typeIncident(erreur);
        console.error(`Tour interrompu (${code}) : ${String(erreur?.message ?? erreur).slice(0, 160)}`);
        await envoyer({ t: "erreur", code, texte: PHRASES_INCIDENT[code] }).catch(() => {});
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
    ACCUEIL.map(async (texte) => ({ texte, audio: await synthetiser(env, texte).catch(() => null) })),
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

export default {
  async fetch(requete, env, ctx) {
    const { pathname } = new URL(requete.url);

    if (pathname === "/api/accueil" && requete.method === "GET") return accueil(requete, env, ctx);

    if (pathname === "/api/tour" || pathname === "/api/voix") {
      if (requete.method !== "POST") return enJson({ erreur: "Méthode non acceptée." }, 405);
      if (!memeOrigine(requete)) return enJson({ erreur: "Origine refusée." }, 403);
      if (tropDeDemandes(requete)) return enJson({ erreur: "Trop de demandes, réessayez dans une minute." }, 429);

      const corps = await lireCorps(requete);
      if (!corps) return enJson({ erreur: "Demande illisible." }, 400);

      if (pathname === "/api/voix") {
        const texte = typeof corps.texte === "string" ? corps.texte.trim().slice(0, LIMITES.texteVoix) : "";
        if (!texte) return enJson({ erreur: "Texte manquant." }, 400);
        const debut = Date.now();
        try {
          const audio = await synthetiser(env, texte);
          return enJson({ audio, duree: Date.now() - debut, prononce: pourLaVoix(texte, PRONONCIATION) });
        } catch (erreur) {
          return enJson({ erreur: PHRASES_INCIDENT[typeIncident(erreur)] }, 502);
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
