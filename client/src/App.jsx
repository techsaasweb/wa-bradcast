import React, { useState, useEffect, useRef, useMemo } from 'react';
import { io } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import * as XLSX from 'xlsx';

const socket = io('http://localhost:8790');

function App() {
  const [activeTab, setActiveTab] = useState('connection');
  const [status, setStatus] = useState({ connected: false, user: null });
  const [qrCode, setQrCode] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // Messaging State
  const [rawMessage, setRawMessage] = useState(localStorage.getItem('wa_msg') || '');
  const [rawContacts, setRawContacts] = useState(localStorage.getItem('wa_contacts') || '');
  
  const handleRefreshQR = () => {
    socket.emit('refresh_qr');
  };
  
  // Execution State
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, logs: [], results: {} });
  // Realtime lead dari server
  const [serverLeads, setServerLeads] = useState({ total: 0 });

  const handleExcelUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const isCsv = /\.csv$/i.test(file.name);
    const doRows = (rows) => {
      // rows: array of array-of-cells (header=1)
      if (!rows.length) return alert('File kosong / tidak terbaca.');

      // --- DETEKSI KOLOM NOMOR & NAMA DARI HEADER ---
      let phoneIdx = -1, nameIdx = -1;
      const header = (rows[0] || []).map(c => String(c ?? '').toLowerCase().trim());
      header.forEach((h, i) => {
        if (/^(phone|phone62|nomor|no|no\.?\s*wa|wa|number|telp|telepon|hp)/.test(h)) phoneIdx = i;
        if (/^(nama|name|bisnis|business|toko|store|company|perusahaan|title)/.test(h)) nameIdx = i;
      });

      // --- MODE A: ada header nama+nomor (mis. ready01.csv) → jaga nama ---
      if (phoneIdx >= 0) {
        const pairs = [];
        const seen = new Set();
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i] || [];
          const num = String(row[phoneIdx] ?? '').replace(/\D/g, '');
          if (num.length < 9 || num.length > 15) continue;
          let n = num;
          if (n.startsWith('0')) n = '62' + n.slice(1);
          else if (/^8\d{8,12}$/.test(n)) n = '62' + n;
          if (seen.has(n)) continue;
          seen.add(n);
          let nm = '';
          if (nameIdx >= 0) {
            nm = String(row[nameIdx] ?? '').split('|')[0].trim().slice(0, 60);
            // buang embel-embel panjang di nama (mis. "Sewa Motor Bali - BPM Bike & Motor Kuta | Motorbike & Scooter Rental")
            nm = nm.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ').trim();
          }
          pairs.push(nm ? `${n}|${nm}` : n);
        }
        if (pairs.length) {
          setRawContacts(prev => prev + (prev.trim() ? '\n' : '') + pairs.join('\n'));
          alert(`✅ ${pairs.length} kontak masuk (nomor + nama terjaga).`);
        } else {
          alert('Nomor valid tidak ditemukan di kolom phone.');
        }
        return;
      }

      // --- MODE B: tidak ada header dikenali → mode lama, ambil angka di sel mana saja ---
      const extracted = [];
      rows.forEach(row => {
        row.forEach(cell => {
          if (cell) {
            const val = String(cell).replace(/\D/g, '');
            if (val.length >= 10 && val.length <= 13) extracted.push(cell);
          }
        });
      });
      if (extracted.length > 0) {
        setRawContacts(prev => prev + (prev.trim() ? '\n' : '') + extracted.join('\n'));
        alert(`Extracted ${extracted.length} possible contacts from file.`);
      } else {
        alert('No phone numbers found in the spreadsheet.');
      }
    };

    const reader = new FileReader();
    if (isCsv) {
      reader.onload = (event) => {
        const text = new TextDecoder('utf-8').decode(event.target.result);
        doRows(window.__parseCsv ? window.__parseCsv(text) : simpleCsvParse(text));
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (event) => {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        let allRows = [];
        workbook.SheetNames.forEach(sheetName => {
          const worksheet = workbook.Sheets[sheetName];
          allRows = allRows.concat(XLSX.utils.sheet_to_json(worksheet, { header: 1 }));
        });
        doRows(allRows);
      };
      reader.readAsArrayBuffer(file);
    }
  };

  // CSV parser minimal (handle kutip & koma di dalam kutip) — dipakai handleExcelUpload
  function simpleCsvParse(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  const [mediaFile, setMediaFile] = useState(null); // { name, data, type }
  const [docFile, setDocFile] = useState(null);
  const [mediaActive, setMediaActive] = useState(false);
  const [docActive, setDocActive] = useState(false);
  const [delay, setDelay] = useState({ min: 15, max: 45 }); // default aman anti-ban (dulu 1-8, terlalu agresif)

  const handleFileChange = (e, target) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const fileData = {
        name: file.name,
        type: file.type,
        data: event.target.result // Base64
      };
      if (target === 'media') setMediaFile(fileData);
      else setDocFile(fileData);
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    localStorage.setItem('wa_msg', rawMessage);
  }, [rawMessage]);

  useEffect(() => {
    localStorage.setItem('wa_contacts', rawContacts);
  }, [rawContacts]);

  useEffect(() => {
    socket.on('status', (data) => {
      setStatus(data);
      setLoading(false);
      if (data.connected) setQrCode(null);
    });

    socket.on('qr', (data) => {
      setQrCode(data.qr);
      setLoading(false);
    });

    socket.on('broadcast_status', (data) => {
      setProgress(prev => ({
        ...prev,
        current: data.current || prev.current,
        total: data.total || prev.total,
        logs: [`[${new Date().toLocaleTimeString()}] ${data.message}`, ...prev.logs].slice(0, 50),
        results: data.number ? { ...prev.results, [data.number]: data.status } : prev.results
      }));
      if (data.done) setIsBroadcasting(false);
    });

    socket.on('leads_updated', (data) => {
      setServerLeads(data);
      setProgress(prev => ({
        ...prev,
        logs: [`[${new Date().toLocaleTimeString()}] 📥 Lead realtime masuk: +${data.added || 0} (total ${data.total})`, ...prev.logs].slice(0, 50)
      }));
    });
    fetchServerLeads();

    return () => {
      socket.off('status');
      socket.off('qr');
      socket.off('broadcast_status');
      socket.off('leads_updated');
    };
  }, []);

  // --- CONTACT PARSING LOGIC (Indonesia-ready + nama) ---
  // Format per baris: "62812xxxx|Nama" atau "0812xxxx|Nama" atau sekadar nomor.
  const normalizeID = (raw) => {
    if (raw === undefined || raw === null) return null;
    let d = String(raw).replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (/^8\d{8,12}$/.test(d)) d = '62' + d;
    if (!/^62\d{8,13}$/.test(d)) return null;
    return d;
  };
  const parsedContacts = useMemo(() => {
    if (!rawContacts.trim()) return { valid: [], invalid: [], contacts: [] };

    // Split by newline, koma, semicolon — tapi pisahkan nama via "|"
    const items = rawContacts.split(/[\n;]+/);
    const valid = [];
    const invalid = [];
    const contacts = [];
    const seen = new Set();

    items.forEach(line => {
      const parts = String(line).split('|');
      const numPart = (parts[0] || '').trim();
      const namePart = (parts[1] || '').trim();
      // dukung koma di dalam baris: "0812.., 0813.."
      numPart.split(/[, ]+/).forEach(item => {
        if (!item.trim()) return;
        const cleaned = normalizeID(item);
        if (!cleaned) { invalid.push(item + " (Nomor ID tidak valid)"); return; }
        if (!seen.has(cleaned)) {
          seen.add(cleaned);
          valid.push(cleaned);
          contacts.push({ phone: cleaned, name: namePart });
        }
      });
    });

    return { valid, invalid, contacts };
  }, [rawContacts]);

  // --- WHATSAPP PREVIEW FORMATTER ---
  const formatPreview = (text) => {
    let formatted = text
      .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
      .replace(/_(.*?)_/g, '<em>$1</em>')
      .replace(/~(.*?)~/g, `<del>$1</del>`)
      .replace(/`(.*?)`/g, `<code class="bg-black/20 px-1 rounded">$1</code>`)
      .replace(/\n/g, '<br/>');
    return <div dangerouslySetInnerHTML={{ __html: formatted }} />;
  };

  const handleStartBroadcast = () => {
    if (!status.connected) return alert('Please connect WhatsApp first!');
    if (parsedContacts.valid.length === 0) return alert('No valid contacts found!');
    if (isBroadcasting) return alert('Campaign sedang berjalan. Tekan Stop dulu untuk memulai yang baru.');
    
    setIsBroadcasting(true);
    setIsPaused(false);
    setProgress({ current: 0, total: parsedContacts.valid.length, logs: ['Starting broadcast activity...'], results: {} });
    
    socket.emit('start_broadcast', {
      numbers: parsedContacts.valid,
      contacts: parsedContacts.contacts,
      message: rawMessage,
      delay: delay,
      media: mediaActive ? mediaFile : null,
      document: docActive ? docFile : null,
      checkWA: true
    });
  };

  // --- REALTIME: tarik lead dari server (/api/leads) & dengar update socket ---
  const fetchServerLeads = async () => {
    try {
      const r = await fetch('http://localhost:8790/api/leads');
      const j = await r.json();
      setServerLeads(j);
    } catch {}
  };
  const importServerLeads = async () => {
    try {
      const r = await fetch('http://localhost:8790/api/leads');
      const j = await r.json();
      const lines = (j.leads || []).map(l => l.name ? `${l.phone}|${l.name}` : l.phone);
      if (!lines.length) return alert('Belum ada lead di server. Kirim dulu via POST /api/leads.');
      setRawContacts(prev => prev + (prev.trim() ? '\n' : '') + lines.join('\n'));
      alert(`Imported ${lines.length} lead realtime dari server.`);
    } catch { alert('Gagal ambil lead server. Pastikan backend jalan.'); }
  };

  const handleStopBroadcast = () => {
    socket.emit('stop_broadcast');
    setIsBroadcasting(false);
    setIsPaused(false);
  };

  const handlePauseBroadcast = () => {
    const newState = !isPaused;
    setIsPaused(newState);
    socket.emit('pause_broadcast', newState);
  };

  const handleLogout = () => {
    setLoading(true);
    socket.emit('logout');
  };

  if (loading) {
// ... existing loading div ...
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-[#0f172a] text-white">
        <div className="flex space-x-2">
          <div className="w-3 h-3 bg-whatsapp-light rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
          <div className="w-3 h-3 bg-whatsapp-light rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
          <div className="w-3 h-3 bg-whatsapp-light rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
        </div>
        <p className="mt-4 text-slate-400 font-medium">Powering up Dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[#070b14] text-slate-200 flex flex-col items-center">
      {/* Header */}
      <header className="w-full max-w-6xl flex justify-between items-center p-6 border-b border-white/5 bg-black/20 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-whatsapp-light rounded-xl flex items-center justify-center text-white text-xl shadow-[0_0_15px_rgba(37,211,102,0.4)]">
            <i className="fab fa-whatsapp"></i>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Bulk <span className="text-whatsapp-light">Pro</span></h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Smart Sender v2.0</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4">
          <div className={`px-4 py-1.5 rounded-full text-[10px] font-black flex items-center space-x-2 border ${status.connected ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
            <span className={`w-2 h-2 rounded-full ${status.connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></span>
            <span>{status.connected ? 'WA LIVE' : 'OFFLINE'}</span>
          </div>
        </div>
      </header>

      {/* Main Navigation */}
      <nav className="w-full max-w-6xl px-6 py-4 flex space-x-2 overflow-x-auto no-scrollbar">
        {[
          { id: 'connection', label: 'Connect', icon: 'fa-link' },
          { id: 'message', label: 'Message', icon: 'fa-comment-alt' },
          { id: 'contacts', label: 'Contacts', icon: 'fa-users' },
          { id: 'broadcast', label: 'Broadcast', icon: 'fa-paper-plane' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-xl transition-all font-bold text-sm border ${activeTab === tab.id ? 'bg-whatsapp-light/10 text-whatsapp-light border-whatsapp-light/30 shadow-lg shadow-whatsapp-light/5' : 'bg-white/5 border-transparent text-slate-400 hover:bg-white/10'}`}
          >
            <i className={`fas ${tab.icon}`}></i>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      <main className="w-full max-w-6xl p-6 flex-1 flex flex-col items-center">
        <AnimatePresence mode="wait">
          {activeTab === 'connection' && (
            <motion.div key="connection" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full max-w-xl">
              {!status.connected ? (
                <div className="glass p-10 rounded-[2.5rem] premium-shadow w-full flex flex-col items-center relative overflow-hidden border-white/5">
                  <h2 className="text-2xl font-bold mb-2">Device Link</h2>
                  <p className="text-slate-400 text-center mb-8 text-sm">Scan the QR code to link your WhatsApp account.</p>

                  <div className="p-4 bg-white rounded-3xl mb-8 shadow-2xl relative group">
                    {qrCode ? (
                      <img src={qrCode} alt="WhatsApp QR" className="w-64 h-64 grayscale group-hover:grayscale-0 transition-all duration-500" />
                    ) : (
                      <div className="w-64 h-64 flex flex-col items-center justify-center text-slate-800">
                        <i className="fas fa-circle-notch fa-spin text-4xl mb-4 text-whatsapp-light"></i>
                        <p className="text-sm font-bold">Fetching QR...</p>
                      </div>
                    )}
                  </div>
                  <button onClick={handleRefreshQR} className="mb-4 text-xs font-bold text-whatsapp-light hover:underline">Refresh Code</button>
                </div>
              ) : (
                <div className="glass p-10 rounded-[2.5rem] premium-shadow w-full flex flex-col items-center border-white/5">
                  <div className="w-24 h-24 bg-whatsapp-light/10 rounded-full flex items-center justify-center text-whatsapp-light text-5xl mb-6 ring-4 ring-whatsapp-light/5">
                    <i className="fas fa-shield-alt"></i>
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Authenticated</h2>
                  <p className="text-slate-400 text-center mb-8">Successfully linked to device.</p>
                  <div className="bg-white/5 p-6 rounded-3xl w-full flex items-center space-x-4 mb-8 border border-white/5">
                    <div className="w-14 h-14 bg-gradient-to-br from-whatsapp-light to-whatsapp-teal rounded-full flex items-center justify-center text-2xl font-bold">
                      {status.user?.name ? status.user.name.charAt(0) : <i className="fas fa-user-check"></i>}
                    </div>
                    <div>
                      <p className="text-lg font-bold">{status.user?.name || 'Authorized Device'}</p>
                      <p className="text-xs text-slate-500 font-mono">{status.user?.id ? status.user.id.split('@')[0] : 'Connected'}</p>
                    </div>
                  </div>
                  <button onClick={handleLogout} className="w-full py-4 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-2xl font-bold transition-all border border-red-500/20">
                    Disconnect Session
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'message' && (
            <motion.div key="message" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full flex flex-col lg:flex-row gap-8">
              {/* Message Editor */}
              <div className="flex-1 space-y-6">
                <div className="glass p-8 rounded-[2rem] border-white/5 flex flex-col">
                  <h3 className="text-lg font-bold mb-4 flex items-center space-x-2">
                    <i className="fas fa-pen-nib text-whatsapp-light"></i>
                    <span>Template Editor</span>
                  </h3>
                  <textarea
                    value={rawMessage}
                    onChange={(e) => setRawMessage(e.target.value)}
                    className="w-full h-64 bg-black/30 border border-white/5 rounded-2xl p-6 text-slate-100 focus:outline-none focus:border-whatsapp-light/50 transition-all resize-none font-medium text-base"
                    placeholder="Type your WhatsApp message... (tips anti-ban: pakai {{nama}} + spin {Halo|Hai|Halo kak})"
                  />
                  <div className="mt-4 flex flex-wrap gap-2">
                    {['*Bold*', '_Italic_', '~Strike~', '`Mono`'].map(tag => (
                      <button key={tag} onClick={() => setRawMessage(prev => prev + tag)} className="px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-xs font-mono text-slate-400 border border-white/5">{tag}</button>
                    ))}
                  </div>
                </div>

                <div className="glass p-8 rounded-[2rem] border-white/5">
                  <h3 className="text-lg font-bold mb-4">Media Attachments</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <button className={`p-4 rounded-2xl border flex flex-col items-center space-y-2 transition-all ${mediaActive ? 'bg-whatsapp-light/10 border-whatsapp-light/30 text-whatsapp-light' : 'bg-white/5 border-white/5 text-slate-500'}`} onClick={() => setMediaActive(!mediaActive)}>
                      <i className="fas fa-image text-2xl"></i>
                      <span className="text-xs font-bold">Image/Video</span>
                    </button>
                    <button className={`p-4 rounded-2xl border flex flex-col items-center space-y-2 transition-all ${docActive ? 'bg-whatsapp-teal/10 border-whatsapp-teal/30 text-whatsapp-teal' : 'bg-white/5 border-white/5 text-slate-500'}`} onClick={() => setDocActive(!docActive)}>
                      <i className="fas fa-file-pdf text-2xl"></i>
                      <span className="text-xs font-bold">Document</span>
                    </button>
                  </div>
                  
                  <div className="space-y-3 mt-4">
                    {mediaActive && (
                      <div className="p-4 bg-white/5 rounded-xl border border-dashed border-white/20 text-center">
                        <p className="text-[10px] font-bold text-whatsapp-light mb-1">IMAGE/VIDEO ATTACHMENT</p>
                        <input type="file" className="hidden" id="wa-media" accept="image/*,video/*" onChange={(e) => handleFileChange(e, 'media')} />
                        <label htmlFor="wa-media" className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
                          {mediaFile ? `✅ ${mediaFile.name}` : 'Click to select Image or Video'}
                        </label>
                      </div>
                    )}
                    {docActive && (
                      <div className="p-4 bg-white/5 rounded-xl border border-dashed border-white/20 text-center">
                        <p className="text-[10px] font-bold text-whatsapp-teal mb-1">DOCUMENT ATTACHMENT</p>
                        <input type="file" className="hidden" id="wa-doc" onChange={(e) => handleFileChange(e, 'doc')} />
                        <label htmlFor="wa-doc" className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
                          {docFile ? `✅ ${docFile.name}` : 'Click to select Document/PDF'}
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Live Preview */}
              <div className="w-full lg:w-96 space-y-6">
                <div className="glass p-8 rounded-[2rem] border-white/5 bg-[#0b141a] h-full flex flex-col overflow-hidden relative">
                   {/* WhatsApp Header Mockup */}
                   <div className="absolute top-0 left-0 w-full bg-[#121b22] p-4 flex items-center space-x-3 border-b border-white/5 z-10">
                     <div className="w-8 h-8 rounded-full bg-slate-600 flex items-center justify-center"><i className="fas fa-user text-sm"></i></div>
                     <span className="text-sm font-bold">Recipient Preview</span>
                   </div>

                   <div className="pt-16 flex flex-col h-full bg-[url('https://i.pinimg.com/originals/ab/ab/60/abab60f38a59384a5bc97857310ca43e.png')] bg-contain opacity-80 overflow-y-auto no-scrollbar">
                      {/* Media Block (Priority) */}
                      {mediaActive && mediaFile && (
                        <div className="self-start max-w-[85%] bg-[#202c33] rounded-t-xl overflow-hidden shadow-md ml-2 mt-4">
                           {mediaFile.type.startsWith('image/') ? (
                             <img src={mediaFile.data} alt="Preview" className="w-full object-cover max-h-48" />
                           ) : (
                             <div className="w-full h-32 bg-black/40 flex items-center justify-center flex-col">
                               <i className="fas fa-video text-3xl text-slate-400 mb-2"></i>
                               <span className="text-[10px] text-slate-500">{mediaFile.name}</span>
                             </div>
                           )}
                           <div className="p-3 text-[13px] text-[#e9edef] break-words">
                              {formatPreview(rawMessage)}
                              <div className="text-[9px] text-[#8696a0] text-right mt-1">11:15 PM</div>
                           </div>
                        </div>
                      )}

                      {/* Text Only Block (If no media active) */}
                      {(!mediaActive || !mediaFile) && (
                        <div className="self-start max-w-[85%] bg-[#202c33] rounded-tr-xl rounded-br-xl rounded-bl-xl p-3 shadow-md relative ml-2 mt-4 text-[13px]">
                          <div className="text-[#e9edef] break-words leading-relaxed font-sans">
                            {formatPreview(rawMessage || 'Your message will appear here...')}
                          </div>
                          <div className="text-[9px] text-[#8696a0] text-right mt-1">11:15 PM</div>
                          <div className="absolute top-0 -left-1.5 w-0 h-0 border-t-[8px] border-t-[#202c33] border-l-[8px] border-l-transparent"></div>
                        </div>
                      )}

                      {/* Document Block */}
                      {docActive && docFile && (
                        <div className="self-start max-w-[85%] bg-[#202c33] rounded-xl p-3 shadow-md ml-2 mt-2 flex items-center space-x-3 border-l-4 border-whatsapp-teal">
                           <i className="fas fa-file-pdf text-2xl text-red-400"></i>
                           <div className="overflow-hidden">
                             <p className="text-[12px] font-bold text-[#e9edef] truncate">{docFile.name}</p>
                             <p className="text-[10px] text-slate-500 uppercase">Document • 1.2 MB</p>
                           </div>
                        </div>
                      )}
                   </div>
                   
                   <p className="text-[10px] text-slate-600 text-center mt-auto bg-black/20 py-2">LIVE WHATSAPP PREVIEW</p>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'contacts' && (
            <motion.div key="contacts" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="glass p-8 rounded-[2rem] border-white/5 space-y-6">
                <div onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('border-whatsapp-light','bg-whatsapp-light/5'); }}
                     onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('border-whatsapp-light','bg-whatsapp-light/5'); }}
                     onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('border-whatsapp-light','bg-whatsapp-light/5');
                       const f = e.dataTransfer.files && e.dataTransfer.files[0];
                       if (f) { const inp = document.getElementById('wa-excel'); if (inp) { const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files; inp.dispatchEvent(new Event('change')); } }
                     }}
                     className="flex justify-between items-center bg-black/20 p-4 rounded-2xl border border-dashed border-white/15 transition-all">
                   <div className="flex flex-col">
                      <span className="text-[10px] font-bold text-slate-500 uppercase">Smart Spreadsheet Import — drag &amp; drop file di sini</span>
                      <input type="file" id="wa-excel" className="hidden" accept=".xlsx, .xls, .csv" onChange={handleExcelUpload} />
                      <label htmlFor="wa-excel" className="text-xs font-bold text-whatsapp-light cursor-pointer hover:underline flex items-center space-x-2 mt-1">
                        <i className="fas fa-file-excel"></i>
                        <span>Upload Excel/CSV</span>
                      </label>
                      <button onClick={importServerLeads} className="text-xs font-bold text-sky-400 cursor-pointer hover:underline flex items-center space-x-2 mt-2">
                        <i className="fas fa-bolt"></i>
                        <span>Import Realtime ({serverLeads.total || 0} lead di server)</span>
                      </button>
                   </div>
                   <button onClick={() => setRawContacts('')} className="p-2 text-red-500/50 hover:text-red-500 transition-all">
                      <i className="fas fa-trash-alt"></i>
                   </button>
                </div>

                <div>
                  <h3 className="text-sm font-bold mb-4 flex items-center space-x-2 text-slate-400">
                    <i className="fas fa-keyboard"></i>
                    <span>Manual Paste / Raw Content</span>
                  </h3>
                  <textarea
                    value={rawContacts}
                    onChange={(e) => setRawContacts(e.target.value)}
                    className="w-full h-80 bg-black/30 border border-white/5 rounded-2xl p-6 text-slate-100 focus:outline-none focus:border-whatsapp-light/5 focus:ring-1 focus:ring-whatsapp-light/20 transition-all resize-none font-mono text-sm shadow-inner"
                    placeholder="Format ID: 0812xxxx|Nama Toko, 62812xxxx|Nama — atau paste nomor biasa. Variabel pesan: {{nama}}"
                  />
                </div>
              </div>

              <div className="space-y-6">
                <div className="glass p-8 rounded-[2rem] border-white/5">
                  <h3 className="text-lg font-bold mb-6">Discovery Result</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-whatsapp-light/5 border border-whatsapp-light/20 p-4 rounded-2xl">
                      <p className="text-slate-500 text-[10px] font-bold uppercase">Valid Unique</p>
                      <p className="text-3xl font-black text-whatsapp-light">{parsedContacts.valid.length}</p>
                    </div>
                    <div className="bg-red-500/5 border border-red-500/20 p-4 rounded-2xl">
                      <p className="text-slate-500 text-[10px] font-bold uppercase">Invalid Found</p>
                      <p className="text-3xl font-black text-red-400">{parsedContacts.invalid.length}</p>
                    </div>
                  </div>
                </div>

                <div className="glass p-8 rounded-[2rem] border-white/5 flex-1 overflow-hidden flex flex-col">
                  <h3 className="text-sm font-bold mb-4 text-slate-400">Cleaned List (Preview)</h3>
                  <div className="flex-1 bg-black/40 rounded-2xl p-4 overflow-y-auto max-h-[250px] font-mono text-xs space-y-1">
                    {parsedContacts.valid.map((num, i) => (
                      <div key={i} className="flex items-center space-x-2 text-green-400/80">
                        <span className="text-slate-600 text-[9px] w-6">{i+1}.</span>
                        <span>{num}</span>
                      </div>
                    ))}
                    {parsedContacts.valid.length === 0 && <p className="text-slate-600 italic">No numbers identified yet...</p>}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'broadcast' && (
            <motion.div key="broadcast" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full max-w-4xl flex flex-col space-y-8">
              {/* Settings / Delay */}
              {!isBroadcasting && (
                <div className="glass p-8 rounded-[2rem] border-white/5 grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                   <div>
                      <h3 className="text-lg font-bold mb-2">Manual Delay (anti-ban)</h3>
                      <p className="text-sm text-slate-400">Time between each message (seconds). Aman: 15-60. Batch otomatis jeda 60s tiap 10 pesan, limit 200/hari.</p>
                   </div>
                   <div className="flex items-center space-x-4">
                      <div className="flex-1 space-y-2">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Min Delay</label>
                        <input type="number" value={delay.min} onChange={(e) => setDelay({...delay, min: parseInt(e.target.value)})} className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-center"/>
                      </div>
                      <div className="flex-1 space-y-2">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Max Delay</label>
                        <input type="number" value={delay.max} onChange={(e) => setDelay({...delay, max: parseInt(e.target.value)})} className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-center"/>
                      </div>
                   </div>
                </div>
              )}

              {/* Broadcast Controls */}
              <div className="glass p-10 rounded-[2.5rem] border-white/5 flex flex-col items-center">
                 <div className="w-full flex flex-col sm:flex-row items-center justify-between mb-8 gap-4">
                    <div className="flex flex-col items-center sm:items-start text-center sm:text-left">
                       <h2 className="text-2xl font-bold">Campaign Status</h2>
                       <p className="text-sm text-slate-400">Progress: {progress.current} / {progress.total}</p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-3">
                       {!isBroadcasting ? (
                         <button 
                          onClick={handleStartBroadcast}
                          className="px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest transition-all bg-whatsapp-light text-white shadow-xl shadow-whatsapp-light/20 hover:scale-105 active:scale-95"
                         >
                           Launch Campaign
                         </button>
                       ) : (
                         <>
                           <button 
                            onClick={handlePauseBroadcast}
                            className={`px-6 py-4 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center space-x-2 ${isPaused ? 'bg-amber-500 text-white' : 'bg-white/10 text-slate-400 border border-white/5 hover:bg-white/20'}`}
                           >
                             <i className={`fas ${isPaused ? 'fa-play' : 'fa-pause'}`}></i>
                             <span>{isPaused ? 'Resume' : 'Pause'}</span>
                           </button>
                           <button 
                            onClick={handleStopBroadcast}
                            className="px-6 py-4 rounded-2xl font-black text-xs uppercase tracking-widest transition-all bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20 flex items-center space-x-2"
                           >
                             <i className="fas fa-stop"></i>
                             <span>Stop</span>
                           </button>
                         </>
                       )}
                    </div>
                 </div>

                 {/* Progress Bar */}
                 <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden mb-12 border border-white/5">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${(progress.current / (progress.total || 1)) * 100}%` }}
                      className="h-full bg-gradient-to-r from-whatsapp-light to-whatsapp-teal shadow-[0_0_15px_rgba(37,211,102,0.5)]"
                    ></motion.div>
                 </div>

                 {/* Results Grid */}
                 <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="flex flex-col">
                       <h4 className="text-xs font-bold text-slate-500 mb-4 uppercase tracking-widest flex items-center space-x-2">
                          <i className="fas fa-terminal"></i>
                          <span>Activity Log</span>
                       </h4>
                       <div className="bg-black/50 border border-white/5 rounded-3xl p-6 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed">
                          {progress.logs.map((log, i) => (
                            <div key={i} className="mb-2 text-slate-400">
                               <span className="text-whatsapp-light">➜</span> {log}
                            </div>
                          ))}
                          {progress.logs.length === 0 && <p className="text-slate-700 italic">Logs will appear here during broadcast...</p>}
                       </div>
                    </div>

                    <div className="flex flex-col">
                       <h4 className="text-xs font-bold text-slate-500 mb-4 uppercase tracking-widest flex items-center space-x-2">
                          <i className="fas fa-th-list"></i>
                          <span>Recipient Feed</span>
                       </h4>
                       <div className="bg-black/50 border border-white/5 rounded-3xl p-6 h-64 overflow-y-auto space-y-3">
                          {parsedContacts.valid.map((num, i) => {
                            const ct = parsedContacts.contacts[i];
                            return (
                            <div key={i} className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                              <div className="flex flex-col min-w-0">
                                 <span className="text-xs font-medium text-slate-300">{num}</span>
                                 {ct && ct.name ? <span className="text-[10px] text-slate-500 truncate" title={ct.name}>{ct.name}</span> : null}
                              </div>
                              <div className="flex items-center space-x-2 flex-shrink-0">
                                 {progress.results[num] === 'success' && <i className="fas fa-check-circle text-whatsapp-light"></i>}
                                 {progress.results[num] === 'error' && <i className="fas fa-times-circle text-red-400"></i>}
                                 {!progress.results[num] && <div className="w-2 h-2 rounded-full bg-white/10"></div>}
                              </div>
                            </div>
                            );
                          })}
                       </div>
                    </div>
                 </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="w-full max-w-6xl p-8 flex justify-between items-center text-slate-600 text-[10px] font-bold uppercase tracking-widest border-t border-white/5 mt-auto">
        <p>© 2026 BulkPro Engine • Secure Messaging Instance</p>
        <div className="flex space-x-4">
          <span className="hover:text-whatsapp-light cursor-pointer">Privacy</span>
          <span className="hover:text-whatsapp-light cursor-pointer">Support</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
