const assert = require('node:assert');
const { encrypt } = require('../scripts/encrypt_link.cjs');
const { entschluesseln } = require('../geheim.js');
(async () => {
  const link = 'https://drive.google.com/drive/folders/abc123?usp=sharing';
  const box = encrypt(link, 'Pässwort 1!', 'Frag deinen Lehrer');
  assert.strictEqual(box.hint, 'Frag deinen Lehrer');
  assert.ok(!JSON.stringify(box).includes('drive.google'), 'Link darf nicht im Klartext stehen');
  assert.strictEqual(await entschluesseln(box, 'Pässwort 1!'), link);
  await assert.rejects(() => entschluesseln(box, 'falsch'));
  await assert.rejects(() => entschluesseln(box, ''));
  assert.notStrictEqual(encrypt(link, 'x').data, encrypt(link, 'x').data, 'jede Verschlüsselung hat eigenen Salt/IV');
  console.log('geheim: ok');
})().catch(e => { console.error(e); process.exit(1); });
