// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds the user
// name, the password, an account or session id nor a glucose value.
// -----------------------------------------------------------------------------

import { CODES } from './dexcom/errors.js';

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** A delay in words: minutes below 1 h, hours above. */
const delayText = (ms) => {
  const m = minutes(ms);
  if (m < 60) return { en: `${m} min`, fr: `${m} min` };
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const t = rest ? `${h} h ${rest} min` : `${h} h`;
  return { en: t, fr: t };
};

/** Why Dexcom Share failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.TLS_UNTRUSTED:
      return { en: 'certificate not trusted', fr: 'certificat non reconnu' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => {
  const d = delayText(delay);
  return { en: `Retried in ${d.en}.`, fr: `Nouvel essai dans ${d.fr}.` };
};

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    /** `state`: current, stale (only its age), future (clock?) or none. */
    ok: ({ state, staleMinutes }) => {
      if (state === 'current') {
        return {
          en: 'Dexcom Share answers: the latest measurement is current.',
          fr: 'Dexcom Share répond : la dernière mesure est à jour.',
        };
      }
      if (state === 'stale') {
        return {
          en: `Dexcom Share answers, but the latest measurement is more than ${staleMinutes} min old (sensor, phone or Share app?): its glucose and trend are not published as current, only its age.`,
          fr: `Dexcom Share répond, mais la dernière mesure a plus de ${staleMinutes} min (capteur, téléphone ou application Share ?) : sa glycémie et sa tendance ne sont pas publiées comme actuelles, seulement son âge.`,
        };
      }
      if (state === 'future') {
        return {
          en: 'Dexcom Share answers, but the latest measurement is dated in the future: check the clock of Gladys (the measurement is not published as current).',
          fr: 'Dexcom Share répond, mais la dernière mesure est datée dans le futur : vérifiez l’horloge de Gladys (la mesure n’est pas publiée comme actuelle).',
        };
      }
      return {
        en: 'Dexcom Share answers, but gives no measurement for the last 24 hours (sensor, phone, Share turned off?).',
        fr: 'Dexcom Share répond, mais ne donne aucune mesure des dernières 24 heures (capteur, téléphone, partage Share désactivé ?).',
      };
    },
    missingCredentials: {
      en: 'Type the user name (or e-mail address, or phone number) and the password of the Dexcom account of the person wearing the sensor, and choose its region.',
      fr: 'Saisissez le nom d’utilisateur (ou l’adresse e-mail, ou le numéro de téléphone) et le mot de passe du compte Dexcom de la personne qui porte le capteur, et choisissez sa région.',
    },
    usernameInvalid: {
      en: 'The user name holds a line break or a control character (pasted?): type it again. Nothing was sent.',
      fr: 'Le nom d’utilisateur contient un retour à la ligne ou un caractère de contrôle (collé ?) : saisissez-le de nouveau. Rien n’a été envoyé.',
    },
    passwordInvalid: {
      en: 'The password holds a line break or a control character (pasted?): type it again. Nothing was sent.',
      fr: 'Le mot de passe contient un retour à la ligne ou un caractère de contrôle (collé ?) : saisissez-le de nouveau. Rien n’a été envoyé.',
    },
    configUnreadable: {
      en: 'Gladys did not give the configuration of the integration: read again in 1 min.',
      fr: 'Gladys n’a pas transmis la configuration de l’intégration : nouvelle lecture dans 1 min.',
    },
    refused: (delay) =>
      join({
        en: `Dexcom refused the user name or the password, or the account is not in the chosen region. A wrong password tried again and again locks the account: Gladys stops for ${delayText(delay).en} (1 h, then 6 h, then 24 h). Check the credentials and the region, then save the configuration: it tries once per series of refusals (other credentials or another region: at once).`,
        fr: `Dexcom a refusé le nom d’utilisateur ou le mot de passe, ou le compte n’est pas dans la région choisie. Un mauvais mot de passe essayé encore et encore bloque le compte : Gladys s’arrête ${delayText(delay).fr} (1 h, puis 6 h, puis 24 h). Vérifiez les identifiants et la région, puis enregistrez la configuration : elle fait un essai par série de refus (d’autres identifiants ou une autre région : tout de suite).`,
      }),
    locked: (delay) =>
      join({
        en: `Dexcom locked the account after too many attempts. Gladys stops for ${delayText(delay).en} (1 h, then 6 h, then 24 h) so as not to lock it longer. Check the password in the Dexcom app, then save the configuration (one attempt per series of stops).`,
        fr: `Dexcom a bloqué le compte après trop d’essais. Gladys s’arrête ${delayText(delay).fr} (1 h, puis 6 h, puis 24 h) pour ne pas le bloquer plus longtemps. Vérifiez le mot de passe dans l’application Dexcom, puis enregistrez la configuration (un essai par série d’arrêts).`,
      }),
    stillRefused: (delay, forced = false, locked = false) => {
      const what = locked
        ? {
            en: 'Dexcom locked the account earlier (too many attempts)',
            fr: 'Dexcom a bloqué le compte plus tôt (trop d’essais)',
          }
        : {
            en: 'Dexcom refused these credentials earlier',
            fr: 'Dexcom a refusé ces identifiants plus tôt',
          };
      return forced
        ? {
            en: `${what.en}, and they were already tried again: next attempt in ${delayText(delay).en} (other credentials or another region are tried at once).`,
            fr: `${what.fr}, et ils ont déjà été réessayés : prochain essai dans ${delayText(delay).fr} (d’autres identifiants ou une autre région sont essayés tout de suite).`,
          }
        : {
            en: `${what.en}: Gladys waits ${delayText(delay).en} before trying again (saving the configuration tries once at once).`,
            fr: `${what.fr} : Gladys attend ${delayText(delay).fr} avant de réessayer (enregistrer la configuration fait un essai tout de suite).`,
          };
    },
    alreadyRetried: (delay) => ({
      en: `Already tried again after this stop: next attempt in ${delayText(delay).en}. Saving the same credentials again does not shorten the stop (other credentials or another region are tried at once).`,
      fr: `Déjà réessayé après cet arrêt : prochain essai dans ${delayText(delay).fr}. Enregistrer de nouveau les mêmes identifiants ne raccourcit pas l’arrêt (d’autres identifiants ou une autre région sont essayés tout de suite).`,
    }),
    session: (delay) =>
      join(
        {
          en: 'Dexcom Share refused the session it had just opened.',
          fr: 'Dexcom Share a refusé la session qu’il venait d’ouvrir.',
        },
        RETRY(delay),
      ),
    region: (delay) =>
      join(
        {
          en: 'The region of the configuration is not a Dexcom Share region: nothing was sent.',
          fr: 'La région de la configuration n’est pas une région Dexcom Share : rien n’a été envoyé.',
        },
        RETRY(delay),
      ),
    internal: (delay) =>
      join(
        {
          en: 'Internal error of the integration while reading the answer of Dexcom Share (see the logs of the integration).',
          fr: 'Erreur interne de l’intégration en lisant la réponse de Dexcom Share (voir les journaux de l’intégration).',
        },
        RETRY(delay),
      ),
    tooLarge: (delay) =>
      join(
        {
          en: 'Dexcom Share answers, but the answer is too large (above 256 KB).',
          fr: 'Dexcom Share répond, mais la réponse est trop grande (plus de 256 Ko).',
        },
        RETRY(delay),
      ),
    tlsUntrusted: (delay) =>
      join(
        {
          en: 'The certificate of the Dexcom Share API is not trusted: nothing was sent (a proxy or a firewall in between?).',
          fr: 'Le certificat de l’API Dexcom Share n’est pas reconnu : rien n’a été envoyé (un proxy ou un pare-feu entre les deux ?).',
        },
        RETRY(delay),
      ),
    forbidden: (delay) =>
      join(
        {
          en: 'Access refused (HTTP 403) by Dexcom Share or by something in between (a firewall, a proxy?).',
          fr: 'Accès refusé (HTTP 403) par Dexcom Share ou par un intermédiaire (un pare-feu, un proxy ?).',
        },
        RETRY(delay),
      ),
    badAnswer: (delay) =>
      join(
        {
          en: 'The Dexcom Share API answers in an unexpected way (it may have changed).',
          fr: 'L’API Dexcom Share répond de façon inattendue (elle a peut-être changé).',
        },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'Dexcom Share asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Dexcom Share demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `Dexcom Share answers with a server error (HTTP ${status}, maintenance?): every request is paused.`,
          fr: `Dexcom Share répond par une erreur serveur (HTTP ${status}, maintenance ?) : toutes les requêtes sont suspendues.`,
        },
        RETRY(delay),
      ),
    paused: (delay) =>
      join(
        {
          en: 'Dexcom Share asked Gladys to wait (HTTP 429 or a server error): the pause goes on.',
          fr: 'Dexcom Share a demandé à Gladys d’attendre (HTTP 429 ou erreur serveur) : la pause continue.',
        },
        RETRY(delay),
      ),
    retryPending: (delay) =>
      join(
        {
          en: 'The last reading of Dexcom Share failed (before the restart of the integration).',
          fr: 'La dernière lecture de Dexcom Share a échoué (avant le redémarrage de l’intégration).',
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'Dexcom Share does not answer:', fr: 'Dexcom Share ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ state }) =>
      state === 'current'
        ? {
            en: 'Connected: the latest measurement is current. Add the sensor from the Discovery tab.',
            fr: 'Connecté : la dernière mesure est à jour. Ajoutez le capteur depuis l’onglet Découverte.',
          }
        : {
            en: 'Connected, but the latest measurement is not current (see the status). Add the sensor from the Discovery tab.',
            fr: 'Connecté, mais la dernière mesure n’est pas à jour (voir l’état). Ajoutez le capteur depuis l’onglet Découverte.',
          },
  },
  errors: {
    readOnly: 'This integration only reads Dexcom Share: nothing can be changed from Gladys',
    notConnected: 'Dexcom Share is not connected: see the configuration of the integration',
    testTooLong:
      'Dexcom Share has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
