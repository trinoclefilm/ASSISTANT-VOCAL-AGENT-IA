import {
  DetecteurParole,
  decoderBase64,
  jouerTampon,
  ouvrirMicro,
  parlerNavigateur,
  priseEnWavBase64,
  texteConsommation,
} from "/audio.js";
import { creerTourelle } from "/tourelle.js";

const $ = (id) => document.getElementById(id);
const parametres = new URLSearchParams(location.search);
const integre = parametres.has("integre");
const avecMesures = parametres.has("mesures");
const voixChoisie = parametres.get("voix") === "navigateur" ? "navigateur" : "cloudflare";
if (integre) document.documentElement.classList.add("integre");

const tourelle = creerTourelle($("tourelle-svg"));
const STATUTS = {
  repos: "",
  ecoute: "Je vous écoute.",
  reflexion: "Je cherche la réponse.",
  parole: "Touchez l'objectif pour m'interrompre.",
  ecrit: "Écrivez votre question ci-dessous.",
  pause: "Micro coupé. Touchez l'objectif pour reprendre.",
};
const LANGUES_PAGE = { fr: "fr", en: "en", zh: "zh-CN" };
const NOMS_LANGUES = { fr: "français", en: "anglais", zh: "chinois" };
const LIBELLES = {
  repos: "Parler à l'assistant",
  ecoute: "Terminer ma question maintenant",
  reflexion: "Annuler la réponse en cours",
  parole: "Interrompre l'assistant",
  ecrit: "Activer le micro",
  pause: "Réactiver le micro",
};

const etat = {
  phase: "repos",
  contexte: null,
  micro: null,
  detecteur: null,
  analyseur: null,
  historique: [],
  file: [],
  lecture: null,
  enLecture: false,
  fluxTermine: true,
  controleur: null,
  reponseEnCours: "",
  questionEnCours: "",
  silencesVides: 0,
  saisieActive: false,
  minuteurVeille: null,
  finParole: 0,
  premierSon: null,
  ecouteDepuis: 0,
  jeton: 0,
  langue: null,
};

function signaler(type, donnees = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: "trinocle-voix", type, ...donnees }, "*");
}

function niveauLecture() {
  if (!etat.analyseur) return 0.45 + Math.sin(performance.now() / 170) * 0.2;
  const tampon = new Uint8Array(etat.analyseur.fftSize);
  etat.analyseur.getByteTimeDomainData(tampon);
  let somme = 0;
  for (const v of tampon) somme += ((v - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(somme / tampon.length) * 5);
}

function passerA(phase) {
  if (etat.phase === phase) return;
  etat.phase = phase;
  document.body.dataset.phase = phase;
  $("statut").textContent = STATUTS[phase];
  $("tourelle").setAttribute("aria-label", LIBELLES[phase]);
  const source = phase === "ecoute" ? () => etat.detecteur?.niveau ?? 0 : phase === "parole" ? niveauLecture : null;
  tourelle.regler(phase, source);
  signaler("etat", { phase });

  clearTimeout(etat.minuteurVeille);
  if (phase === "ecoute") {
    etat.ecouteDepuis = performance.now();
    // Personne ne parle depuis longtemps : on ne laisse pas le micro ouvert pour rien.
    etat.minuteurVeille = setTimeout(() => {
      if (etat.phase === "ecoute" && !etat.detecteur?.enParole) mettreEnPause();
    }, 45000);
  }
}

function sousTitres(question, reponse) {
  if (question !== undefined) {
    $("st-question").textContent = question ? `Vous : ${question}` : "";
  }
  if (reponse !== undefined) $("st-reponse").textContent = reponse;
}

function afficherCartes(intention) {
  $("carte-exemples").hidden = intention !== "exemples";
  $("carte-deroule").hidden = intention !== "deroule";
  $("carte-prix").hidden = intention !== "prix";
  $("bouton-rdv").classList.toggle("eclaire", intention === "rdv" || intention === "prix");
  if (intention) signaler("intention", { intention });
}

function surTrameMicro(echantillons) {
  if (etat.phase !== "ecoute" || etat.saisieActive) return;
  // Juste après la réponse, le micro entend encore la fin de la voix dans le haut-parleur.
  if (performance.now() - etat.ecouteDepuis < 350) return;
  etat.detecteur?.trame(echantillons);
}

async function activerMicro() {
  if (etat.micro) return true;
  try {
    etat.micro = await ouvrirMicro(etat.contexte, surTrameMicro);
    etat.detecteur = new DetecteurParole(etat.contexte.sampleRate, {
      surFin: (prise) => {
        etat.finParole = performance.now();
        poser({ audio: priseEnWavBase64(prise, etat.contexte.sampleRate) });
      },
    });
    $("aide").textContent = "";
    return true;
  } catch {
    $("aide").textContent = "Le micro n'est pas autorisé. Vous pouvez écrire votre question, ou l'autoriser dans les réglages du navigateur.";
    return false;
  }
}

function fermerMicro() {
  etat.micro?.fermer();
  etat.micro = null;
  etat.detecteur = null;
}

function mettreEnPause() {
  fermerMicro();
  passerA("pause");
}

const phaseAttente = () => (etat.micro ? "ecoute" : "ecrit");

function memoriserEchange() {
  // L'introduction n'a pas de question : elle ne rejoint pas l'historique.
  if (etat.questionEnCours && etat.reponseEnCours) {
    etat.historique.push(
      { role: "user", content: etat.questionEnCours },
      { role: "assistant", content: etat.reponseEnCours },
    );
    etat.historique = etat.historique.slice(-6);
  }
}

function finDeReponse() {
  memoriserEchange();
  signaler("reponse", { texte: etat.reponseEnCours });
  etat.questionEnCours = "";
  etat.reponseEnCours = "";
  etat.detecteur?.reinitialiser();
  passerA(phaseAttente());
}

async function lireSuivante() {
  if (etat.enLecture) return;
  const phrase = etat.file.shift();
  if (!phrase) {
    if (etat.fluxTermine) finDeReponse();
    else passerA("reflexion");
    return;
  }
  etat.enLecture = true;
  const jeton = etat.jeton;
  let tampon = null;
  if (phrase.audio) {
    try {
      tampon = await decoderBase64(etat.contexte, phrase.audio);
    } catch {
      tampon = null;
    }
  }
  if (jeton !== etat.jeton) return;

  etat.reponseEnCours = `${etat.reponseEnCours} ${phrase.texte}`.trim();
  $("st-reponse").lang = LANGUES_PAGE[phrase.langue] ?? "fr";
  sousTitres(undefined, phrase.texte);
  passerA("parole");
  if (etat.finParole && etat.premierSon === null) {
    etat.premierSon = performance.now() - etat.finParole;
    if (avecMesures) $("mesures").textContent = `Premier son ${Math.round(etat.premierSon)} ms après la fin de la question.`;
  }
  etat.lecture = tampon ? jouerTampon(etat.contexte, tampon, etat.analyseur) : parlerNavigateur(phrase.texte, phrase.langue);
  await etat.lecture.fini;
  if (jeton !== etat.jeton) return;
  etat.lecture = null;
  etat.enLecture = false;
  lireSuivante();
}

function couper() {
  etat.jeton += 1;
  etat.controleur?.abort();
  etat.controleur = null;
  etat.lecture?.arreter();
  etat.lecture = null;
  etat.enLecture = false;
  etat.file = [];
  etat.fluxTermine = true;
}

function ajouterPhrase(phrase) {
  etat.file.push(phrase);
  lireSuivante();
}

function traiter(message) {
  switch (message.t) {
    case "transcription":
      etat.questionEnCours = message.texte;
      etat.langue = message.langue ?? etat.langue;
      etat.silencesVides = 0;
      $("aide").textContent = "";
      $("st-question").lang = LANGUES_PAGE[etat.langue] ?? "fr";
      sousTitres(message.texte, "");
      signaler("transcription", { texte: message.texte, langue: etat.langue });
      break;
    case "intention":
      afficherCartes(message.intention);
      break;
    case "phrase":
      ajouterPhrase({ texte: message.texte, audio: message.audio, langue: etat.langue ?? "fr" });
      break;
    case "rien":
      etat.silencesVides += 1;
      if (etat.silencesVides >= 2) $("aide").textContent = "Je n'entends pas bien. Rapprochez-vous du micro, ou écrivez votre question.";
      break;
    case "erreur":
      afficherCartes("rdv");
      ajouterPhrase({ texte: message.texte, audio: null, langue: message.langue ?? etat.langue ?? "fr" });
      break;
    case "fin":
      if (avecMesures && message.mesures) {
        const m = message.mesures;
        const langue = etat.langue ? ` Langue : ${NOMS_LANGUES[etat.langue]}.` : "";
        $("mesures").textContent = `${etat.premierSon ? `Premier son ${Math.round(etat.premierSon)} ms. ` : ""}Transcription ${m.transcription ?? 0} ms, premier mot ${m.premierMot ?? 0} ms, première voix ${m.premiereVoix ?? 0} ms.${langue} ${texteConsommation(m.conso)}`;
      }
      break;
    default:
  }
}

async function poser({ audio, texte }) {
  couper();
  const jeton = etat.jeton;
  afficherCartes(null);
  etat.questionEnCours = "";
  etat.reponseEnCours = "";
  etat.premierSon = null;
  etat.fluxTermine = false;
  if (texte) sousTitres(texte, "");
  passerA("reflexion");
  $("suggestions").hidden = true;

  const controleur = new AbortController();
  etat.controleur = controleur;
  try {
    const reponse = await fetch("/api/tour", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio, texte, historique: etat.historique, voix: voixChoisie, langue: etat.langue }),
      signal: controleur.signal,
    });
    if (!reponse.ok) {
      const corps = await reponse.json().catch(() => ({}));
      traiter({ t: "erreur", texte: corps.erreur ?? "Je n'ai pas réussi à répondre. Réessayez dans un instant." });
    } else {
      const lecteur = reponse.body.pipeThrough(new TextDecoderStream()).getReader();
      let tampon = "";
      for (;;) {
        const { value, done } = await lecteur.read();
        if (done) break;
        tampon += value;
        let saut;
        while ((saut = tampon.indexOf("\n")) >= 0) {
          const ligne = tampon.slice(0, saut);
          tampon = tampon.slice(saut + 1);
          if (ligne && jeton === etat.jeton) traiter(JSON.parse(ligne));
        }
      }
    }
  } catch (erreur) {
    if (erreur.name === "AbortError") return;
    traiter({ t: "erreur", texte: "La connexion a été coupée. Vérifiez votre réseau et réessayez.", langue: "fr" });
  }
  if (jeton !== etat.jeton) return;
  etat.fluxTermine = true;
  if (!etat.enLecture && !etat.file.length) lireSuivante();
}

async function jouerAccueil() {
  etat.fluxTermine = false;
  passerA("reflexion");
  const jeton = etat.jeton;
  try {
    const reponse = await fetch("/api/accueil");
    const { phrases } = await reponse.json();
    if (jeton !== etat.jeton) return;
    for (const phrase of phrases) etat.file.push({ texte: phrase.texte, audio: voixChoisie === "navigateur" ? null : phrase.audio, langue: "fr" });
  } catch {
    etat.file.push({ texte: "Bonjour, je suis l'assistant vocal de Trinocle Film, une intelligence artificielle. Je vous écoute.", audio: null, langue: "fr" });
  }
  etat.fluxTermine = true;
  lireSuivante();
}

// À appeler pendant un toucher : les téléphones n'autorisent le son qu'à ce moment-là.
function preparerAudio() {
  document.body.classList.add("lance");
  etat.contexte = new (window.AudioContext || window.webkitAudioContext)();
  const pret = etat.contexte.resume();
  etat.analyseur = etat.contexte.createAnalyser();
  etat.analyseur.fftSize = 512;
  etat.analyseur.connect(etat.contexte.destination);
  if (window.speechSynthesis) speechSynthesis.getVoices();
  return pret;
}

async function demarrer() {
  if (document.body.classList.contains("lance")) return;
  await preparerAudio();
  await activerMicro();
  $("suggestions").hidden = false;
  jouerAccueil();
}

function terminer() {
  couper();
  fermerMicro();
  etat.contexte?.close();
  etat.contexte = null;
  etat.analyseur = null;
  etat.historique = [];
  etat.langue = null;
  afficherCartes(null);
  sousTitres("", "");
  $("mesures").textContent = "";
  $("aide").textContent = "";
  document.body.classList.remove("lance");
  passerA("repos");
}

$("tourelle").addEventListener("click", async () => {
  switch (etat.phase) {
    case "repos":
      demarrer();
      break;
    case "parole":
    case "reflexion":
      couper();
      memoriserEchange();
      etat.questionEnCours = "";
      etat.reponseEnCours = "";
      etat.detecteur?.reinitialiser();
      passerA(phaseAttente());
      break;
    case "ecoute":
      if (etat.detecteur?.enParole) etat.detecteur.terminer();
      break;
    case "ecrit":
    case "pause":
      if (await activerMicro()) passerA("ecoute");
      break;
    default:
  }
});
$("bouton-demarrer").addEventListener("click", demarrer);
$("bouton-terminer").addEventListener("click", terminer);

$("composeur").addEventListener("submit", (e) => {
  e.preventDefault();
  const texte = $("question").value.trim();
  if (!texte) return;
  $("question").value = "";
  $("question").blur();
  if (!document.body.classList.contains("lance")) preparerAudio();
  poser({ texte });
});
$("question").addEventListener("focus", () => {
  etat.saisieActive = true;
  etat.detecteur?.reinitialiser();
});
$("question").addEventListener("blur", () => {
  etat.saisieActive = false;
});

document.querySelectorAll("[data-question]").forEach((bouton) => {
  bouton.addEventListener("click", () => poser({ texte: bouton.dataset.question }));
});

document.body.dataset.phase = "repos";
$("tourelle").setAttribute("aria-label", LIBELLES.repos);
