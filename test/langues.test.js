import assert from "node:assert/strict";
import { test } from "node:test";
import { NOMS_PROPRES, PRONONCIATION } from "../src/connaissances.js";
import {
  calculerConsommation,
  choisirLangue,
  DecoupeurPhrases,
  detecterIntention,
  devinerLangue,
  dureeMp3,
  estInvention,
  langueValide,
  lireFluxModele,
  pourLaVoix,
} from "../src/voix.js";

test("seules les langues prévues sont acceptées", () => {
  assert.equal(langueValide("fr"), "fr");
  assert.equal(langueValide("EN"), "en");
  assert.equal(langueValide("yue"), "zh");
  assert.equal(langueValide("es"), null);
  assert.equal(langueValide("constructor"), null);
  assert.equal(langueValide(undefined), null);
});

test("on suit Whisper quand il est sûr, sinon on garde la langue de la conversation", () => {
  assert.deepEqual(choisirLangue("en", 0.97, "fr"), { langue: "en", refaire: false });
  assert.deepEqual(choisirLangue("zh", 0.9, null), { langue: "zh", refaire: false });
  assert.deepEqual(choisirLangue("fr", undefined, null), { langue: "fr", refaire: false });
  // Accent : Whisper hésite, la conversation était en français.
  assert.deepEqual(choisirLangue("zh", 0.41, "fr"), { langue: "fr", refaire: true });
  // Il hésite, mais confirme la langue en cours : inutile de refaire.
  assert.deepEqual(choisirLangue("en", 0.3, "en"), { langue: "en", refaire: false });
  // Langue non prévue : on refait en français.
  assert.deepEqual(choisirLangue("es", 0.99, null), { langue: "fr", refaire: true });
});

test("la langue d'une question écrite est devinée", () => {
  assert.equal(devinerLangue("Combien ça coûte ?"), "fr");
  assert.equal(devinerLangue("How much does it cost?"), "en");
  assert.equal(devinerLangue("What is the return on investment?"), "en");
  assert.equal(devinerLangue("多少钱？"), "zh");
  assert.equal(devinerLangue("Trinocle Film 的价格是多少？"), "zh");
  assert.equal(devinerLangue("OK", "en"), "en");
  assert.equal(devinerLangue("OK"), "fr");
});

test("la voix anglaise et chinoise ne reçoit pas les nombres en lettres françaises", () => {
  assert.equal(pourLaVoix("A basket of 300 € and 30 % lost & 50,000 views", PRONONCIATION.en, "en"), "A basket of 300 euros and 30 percent lost and 50000 views");
  assert.equal(pourLaVoix("TRINOCLE FILM improves your ROI.", PRONONCIATION.en, "en"), "Trinocle Film improves your return on investment");
  assert.equal(pourLaVoix("转化率提高 30 %，预算 300 €。", PRONONCIATION.zh, "zh"), "转化率提高 百分之30，预算 300欧元。");
  assert.equal(pourLaVoix("**你好** https://calendly.com/x 🎬", PRONONCIATION.zh, "zh"), "你好");
});

test("les inventions de Whisper sont écartées en anglais et en chinois, pas les vraies questions", () => {
  for (const faux of ["Thank you for watching!", "Thank you.", "you", "Please subscribe to my channel", "字幕由Amara.org社区提供", "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", "谢谢观看", "ご視聴ありがとうございました", NOMS_PROPRES]) {
    assert.equal(estInvention(faux, NOMS_PROPRES), true, faux);
  }
  for (const vrai of ["多少钱？", "你们做什么？", "好", "How long does a project take?", "Thank you, that's clear. And the price?"]) {
    assert.equal(estInvention(vrai, NOMS_PROPRES), false, vrai);
  }
});

test("les intentions sont reconnues en anglais et en chinois", () => {
  const cas = {
    "How much does it cost?": "prix",
    "How much time does a project take?": "deroule",
    "How long does it take?": "deroule",
    "Can I book a call with Torino?": "rdv",
    "What if it doesn't work?": "garantie",
    "Can you show me some examples?": "exemples",
    "Does it connect to my CRM?": "automation",
    "Who are you?": "histoire",
    "多少钱？": "prix",
    "贵公司做什么？": null,
    "我想预约": "rdv",
    "一个项目要多久？": "deroule",
    "有案例吗？": "exemples",
    "The weather is nice": null,
  };
  for (const [texte, attendu] of Object.entries(cas)) assert.equal(detecterIntention(texte), attendu, texte);
});

test("le chinois se découpe au point chinois, même sans espace", () => {
  const texte = "我们为企业制作互动视频。一个项目大约需要八周时间！您想预约吗？";
  const d = new DecoupeurPhrases();
  const phrases = [];
  for (const c of texte) phrases.push(...d.ajouter(c));
  const reste = d.finir();
  if (reste) phrases.push(reste);
  assert.deepEqual(phrases, ["我们为企业制作互动视频。", "一个项目大约需要八周时间！", "您想预约吗？"]);
});

test("le nombre de jetons renvoyé par Cloudflare est récupéré", async () => {
  const encodeur = new TextEncoder();
  const flux = new ReadableStream({
    start(c) {
      c.enqueue(encodeur.encode('data: {"response":"Hello"}\n\ndata: {"response":"","usage":{"prompt_tokens":2100,"completion_tokens":42}}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
  const infos = {};
  let texte = "";
  for await (const m of lireFluxModele(flux, infos)) texte += m;
  assert.equal(texte, "Hello");
  assert.deepEqual(infos.usage, { prompt_tokens: 2100, completion_tokens: 42 });
});

function mp3(entete, longueur, nombre, id3 = false) {
  const debut = id3 ? [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)] : [];
  const octets = new Uint8Array(debut.length + longueur * nombre);
  octets.set(debut);
  for (let i = 0; i < nombre; i += 1) octets.set(entete, debut.length + i * longueur);
  return octets;
}

test("la durée d'un MP3 se lit dans ses trames", () => {
  // MPEG-1, 128 kb/s, 44,1 kHz : trames de 417 octets et 1 152 échantillons.
  const a = dureeMp3(mp3([0xff, 0xfb, 0x90, 0x00], 417, 100, true));
  assert.ok(Math.abs(a - (100 * 1152) / 44100) < 1e-9, String(a));
  // MPEG-2, 32 kb/s, 24 kHz : trames de 96 octets et 576 échantillons.
  const b = dureeMp3(mp3([0xff, 0xf3, 0x44, 0x00], 96, 50));
  assert.ok(Math.abs(b - 1.2) < 1e-9, String(b));
  assert.equal(dureeMp3(new Uint8Array([1, 2, 3, 4, 5])), null);
});

test("la consommation se calcule avec la grille Workers AI", () => {
  const c = calculerConsommation({
    secondesEcoutees: 6,
    secondesDites: 15,
    jetonsLus: 2000,
    jetonsEcrits: 80,
    modele: "@cf/mistralai/mistral-small-3.1-24b-instruct",
  });
  assert.deepEqual(c.neurones, { transcription: 4.7, reponse: 67.8, voix: 4.7, total: 77.2 });
  assert.equal(calculerConsommation({ secondesDites: 6 }).neurones.total, 1.9);
});
