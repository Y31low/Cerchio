import { useRef, useState, useEffect } from 'react'
import './App.css'

const L1 = 100;
const L2 = 100;
const GOMITO = 1;
const ID_MOTORE_1 = 1;
const ID_MOTORE_2 = 2;

function pacchetto(id: number, istruzione: number, parametri: number[]) {
  const len = parametri.length + 2;
  const somma = id + len + istruzione + parametri.reduce((a, b) => a + b, 0);
  const checksum = ~somma & 0xff;
  return new Uint8Array([0xff, 0xff, id, len, istruzione, ...parametri, checksum]);
}

function calcolaInversa(x: number, y: number) {
  const r2 = x * x + y * y;
  let c2 = (r2 - L1 * L1 - L2 * L2) / (2 * L1 * L2);
  c2 = Math.max(-1, Math.min(1, c2)); 
  const t2 = GOMITO * Math.acos(c2);
  const t1 = Math.atan2(y, x) - Math.atan2(L2 * Math.sin(t2), L1 + L2 * Math.cos(t2));
  return { t1, t2 };
}

function radiantiAPassi(radians: number, offset = 2048) {
  return Math.max(0, Math.min(4095, Math.round(offset + (radians / (2 * Math.PI)) * 4096)));
}

const raccordoCubico = (t: number) => t * t * (3 - 2 * t);

function puntoDelCerchio(cx: number, cy: number, raggio: number, s: number) {
  const a = 2 * Math.PI * s;
  return {
    x: cx + raggio * Math.cos(a),
    y: cy + raggio * Math.sin(a),
  };
}

function App() {
  const [connesso, setConnesso] = useState(false);
  const [messaggio, setMessaggio] = useState('In attesa di connessione...');
  const [inMovimento, setInMovimento] = useState(false);

  const portaRef = useRef<SerialPort | null>(null);
  const scrittoreRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const lettoreRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const bufferRef = useRef<number[]>([]);
  const tracciamentoRef = useRef<number | null>(null);

  const connettiServo = async () => {
    try {
      const nuovaPorta = await navigator.serial.requestPort();
      await nuovaPorta.open({ baudRate: 1000000 });
      portaRef.current = nuovaPorta;
      scrittoreRef.current = nuovaPorta.writable!.getWriter();
      lettoreRef.current = nuovaPorta.readable!.getReader();
      bufferRef.current = [];
      setConnesso(true);
      setMessaggio('Motori connessi con successo a 1M baud!');
    } catch (error) {
      console.error(error);
      setMessaggio('Errore durante la connessione alla Seriale.');
    }
  };

  const inviaERicevi = async (pacchettoInviato: Uint8Array, timeoutMs = 100) => {
    const scrittore = scrittoreRef.current;
    const lettore = lettoreRef.current;
    if (!scrittore || !lettore || !portaRef.current) throw new Error('Porta non connessa');

    bufferRef.current = [];
    await scrittore.write(pacchettoInviato);

    const inizio = Date.now();
    try {
      while (Date.now() - inizio < timeoutMs) {
        const { value, done } = await Promise.race([
          lettore.read(),
          new Promise<{ value: undefined; done: true }>((_, reject) => 
            setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs - (Date.now() - inizio))
          )
        ]);

        if (done || !value) break;
        bufferRef.current.push(...value);
        const buf = bufferRef.current;

        if (buf.length >= 4) {
          const expectedLen = buf[3] + 4;
          if (buf.length >= expectedLen) {
            return new Uint8Array(buf.slice(0, expectedLen));
          }
        }
      }
    } catch (error: any) {
      if (error.message === 'TIMEOUT') {
        lettore.releaseLock();
        lettoreRef.current = portaRef.current.readable!.getReader();
        throw new Error('Timeout: nessuna risposta dal motore');
      }
      throw error;
    }
    throw new Error('Timeout generale lettura');
  };

  const inviaPosizione = async (id: number, passi: number) => {
    const p = Math.max(0, Math.min(4095, Math.round(passi)));
    const cmd = pacchetto(id, 0x03, [0x2a, p & 0xff, (p >> 8) & 0xff]);
    if (scrittoreRef.current) {
        await scrittoreRef.current.write(cmd);
    }
  };

  const avviaTracciamento = () => {
    if (!connesso) return;
    const cx = 150, cy = 0;
    const raggio = 40;
    const durataMs = 4000;
    const inizio = performance.now();
    setInMovimento(true);
    setMessaggio('Tracciamento in corso...');

    const passo = async () => {
      let t = (performance.now() - inizio) / durataMs;
      if (t >= 1) {
        t = 1;
        if (tracciamentoRef.current) clearInterval(tracciamentoRef.current);
        setInMovimento(false);
        setMessaggio('Traiettoria completata.');
      }
      const s = raccordoCubico(t);
      const target = puntoDelCerchio(cx, cy, raggio, s);
      const { t1, t2 } = calcolaInversa(target.x, target.y);
      await inviaPosizione(ID_MOTORE_1, radiantiAPassi(t1));
      await inviaPosizione(ID_MOTORE_2, radiantiAPassi(t2));
    };

    if (tracciamentoRef.current) clearInterval(tracciamentoRef.current);
    tracciamentoRef.current = window.setInterval(passo, 20); 
  };

  const fermaTutto = () => {
    if (tracciamentoRef.current) {
      clearInterval(tracciamentoRef.current);
      tracciamentoRef.current = null;
    }
    setInMovimento(false);
    if (scrittoreRef.current) {
      scrittoreRef.current.write(pacchetto(ID_MOTORE_1, 0x03, [0x28, 0]));
      scrittoreRef.current.write(pacchetto(ID_MOTORE_2, 0x03, [0x28, 0]));
    }
    setMessaggio('Motori fermati e rilasciati.');
  };

  useEffect(() => {
    const gestisciVisibilita = () => {
      if (document.visibilityState === "hidden") {
        fermaTutto();
      }
    };
    document.addEventListener("visibilitychange", gestisciVisibilita);
    return () => {
      document.removeEventListener("visibilitychange", gestisciVisibilita);
    };
  }, []);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Controllo Braccio 2R Completo</h1>
        <div className={`status-badge ${connesso ? 'status-online' : 'status-offline'}`}>
          {connesso ? 'Online' : 'Offline'}
        </div>
      </header>
      <div className="grid-container">
        <section className="panel">
          <h2>1. Sistema</h2>
          <div className="action-group">
            <button className="btn btn-primary" onClick={connettiServo} disabled={connesso}>
              Connetti Seriale
            </button>
            <p className="description">Apri la porta COM per collegare la catena di motori.</p>
          </div>
        </section>
        <section className="panel">
          <h2>2. Cerchio</h2>
          <div className="action-row">
            <button className="btn btn-accent" onClick={avviaTracciamento} disabled={!connesso || inMovimento}>
              Avvia Cerchio (4 Secondi)
            </button>
            <button className="btn btn-danger" onClick={fermaTutto} disabled={!connesso}>
              STOP (Rilascia Motori)
            </button>
          </div>
        </section>
      </div>
      <footer className="console-log">
        <p><strong>Log di sistema:</strong> {messaggio}</p>
      </footer>
    </div>
  );
}

export default App;