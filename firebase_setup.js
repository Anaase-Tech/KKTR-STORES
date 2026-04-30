
const { initializeApp, getApps } = require('firebase/app');
const { initializeFirestore, doc, setDoc, getDoc, enableNetwork } = require('firebase/firestore');
const crypto = require('crypto');

const config = {
  apiKey: "AIzaSyDzpR0Yrkj0jDI_4eFP9ARJOwdUvptlVMY",
  authDomain: "kktr-stores-test.firebaseapp.com",
  projectId: "kktr-stores-test",
  storageBucket: "kktr-stores-test.firebasestorage.app",
  messagingSenderId: "47352288339",
  appId: "1:47352288339:web:7f3b7174cb02c6bc7722a6",
  databaseURL: "https://kktr-stores-test-default-rtdb.firebaseio.com"
};

const app = getApps().length === 0 ? require('firebase/app').initializeApp(config) : getApps()[0];
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false
});

function hashPwd(pwd) {
  return crypto.createHash('sha256').update(pwd + 'kktr_salt_2024').digest('hex');
}

async function setup() {
  try {
    await enableNetwork(db);

    // Check if admin exists
    const snap = await getDoc(doc(db, 'users', 'abraham.sackey'));
    if (snap.exists() && snap.data().pwdHash) {
      console.log('ADMIN_EXISTS');
      process.exit(0);
    }

    // Create admin
    const pwdHash = hashPwd('Stores@2024');
    await setDoc(doc(db, 'users', 'abraham.sackey'), {
      id: 'abraham.sackey',
      username: 'abraham.sackey',
      name: 'Abraham Sackey',
      dept: 'Administration',
      role: 'admin',
      approved: true,
      pwdHash: pwdHash,
      createdAt: new Date()
    });

    // Create test ping doc
    await setDoc(doc(db, 'test', 'ping'), { ok: true, ts: new Date().toISOString() });

    console.log('ADMIN_CREATED');
    console.log('HASH:' + pwdHash);
    process.exit(0);
  } catch(e) {
    console.log('ERROR:' + e.message);
    process.exit(1);
  }
}
setup();
