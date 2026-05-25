import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Linking from 'expo-linking';
import nacl from 'tweetnacl';
import {decodeBase64, decodeUTF8, encodeBase64, encodeUTF8} from 'tweetnacl-util';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import {io, Socket} from 'socket.io-client';

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_SERVER =
  Platform.OS === 'ios' ? 'http://127.0.0.1:3000' : 'http://10.0.2.2:3000';

const CLIPBOARD_POLL_MS = 800;

const ICE_SERVERS = [
  {urls: 'stun:stun.l.google.com:19302'},
  {urls: 'stun:stun1.l.google.com:19302'},
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const STORAGE_PEER_ID   = 'bifrost_peer_id';
const STORAGE_DEVICE_ID = 'bifrost_device_id';
const STORAGE_SERVER    = 'bifrost_server_url';

// ── Device ID ─────────────────────────────────────────────────────────────────
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateDeviceId(): string {
  return Array.from(
    {length: 8},
    () => CHARS[Math.floor(Math.random() * CHARS.length)],
  ).join('');
}

async function loadOrCreateDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(STORAGE_DEVICE_ID);
  if (!id) {
    id = generateDeviceId();
    await AsyncStorage.setItem(STORAGE_DEVICE_ID, id);
  }
  return id;
}

// ── Encryption helpers ────────────────────────────────────────────────────────
function encryptText(plaintext: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box   = nacl.secretbox(encodeUTF8(plaintext), nonce, key);
  const out   = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return JSON.stringify({e: encodeBase64(out)});
}

function decryptText(raw: string, key: Uint8Array): string | null {
  try {
    const {e} = JSON.parse(raw);
    if (!e) return null;
    const combined = decodeBase64(e);
    const nonce    = combined.slice(0, nacl.secretbox.nonceLength);
    const box      = combined.slice(nacl.secretbox.nonceLength);
    const msg      = nacl.secretbox.open(box, nonce, key);
    return msg ? decodeUTF8(msg) : null;
  } catch {
    return null;
  }
}

function encryptBinary(data: ArrayBuffer, key: Uint8Array): ArrayBuffer {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box   = nacl.secretbox(new Uint8Array(data), nonce, key);
  const out   = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return out.buffer;
}

function decryptBinary(data: ArrayBuffer, key: Uint8Array): ArrayBuffer | null {
  const combined = new Uint8Array(data);
  const nonce    = combined.slice(0, nacl.secretbox.nonceLength);
  const box      = combined.slice(nacl.secretbox.nonceLength);
  const msg      = nacl.secretbox.open(box, nonce, key);
  return msg ? msg.buffer : null;
}

// ── File helpers ──────────────────────────────────────────────────────────────
interface InboundFile {
  name: string; mimeType: string;
  chunks: ArrayBuffer[]; received: number; total: number;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function saveReceivedFile(inbound: InboundFile): Promise<string> {
  const merged = new Uint8Array(
    inbound.chunks.reduce((acc, c) => acc + c.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of inbound.chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  const base64 = uint8ToBase64(merged);
  const dir  = FileSystem.documentDirectory!;
  const dest = `${dir}${inbound.name}`;
  await FileSystem.writeAsStringAsync(dest, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return dest;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Screen = 'loading' | 'pair' | 'auto' | 'settings';
type Status = 'connecting' | 'securing' | 'connected' | 'error';

export default function App() {
  const [screen, setScreen]       = useState<Screen>('loading');
  const [status, setStatus]       = useState<Status>('connecting');
  const [pairInput, setPairInput] = useState('');
  const [sendText, setSendText]   = useState('');
  const [errorMsg, setErrorMsg]   = useState('');
  const [serverInput, setServerInput] = useState('');
  const [lastFile, setLastFile]   = useState<string | null>(null);

  const deviceIdRef  = useRef<string>('');
  const peerIdRef    = useRef<string>('');
  const serverUrlRef = useRef<string>(DEFAULT_SERVER);
  const socketRef    = useRef<Socket | null>(null);
  const pcRef        = useRef<RTCPeerConnection | null>(null);
  const channelRef   = useRef<RTCDataChannel | null>(null);
  const clipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastClipRef  = useRef('');
  const keyPairRef   = useRef(nacl.box.keyPair());
  const sharedKeyRef = useRef<Uint8Array | null>(null);
  const inboundFileRef = useRef<InboundFile | null>(null);

  // ── Clipboard ────────────────────────────────────────────────────────────
  const stopClipboardPoll = useCallback(() => {
    if (clipTimerRef.current) {
      clearInterval(clipTimerRef.current);
      clipTimerRef.current = null;
    }
  }, []);

  const startClipboardPoll = useCallback(() => {
    lastClipRef.current = '';
    clipTimerRef.current = setInterval(async () => {
      const key = sharedKeyRef.current;
      if (!key || channelRef.current?.readyState !== 'open') return;
      const clip = await Clipboard.getStringAsync();
      if (clip && clip !== lastClipRef.current) {
        lastClipRef.current = clip;
        channelRef.current.send(encryptText(clip, key));
      }
    }, CLIPBOARD_POLL_MS);
  }, []);

  // ── Teardown ──────────────────────────────────────────────────────────────
  const teardownPeer = useCallback(() => {
    stopClipboardPoll();
    channelRef.current   = null;
    sharedKeyRef.current = null;
    lastClipRef.current  = '';
    inboundFileRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
  }, [stopClipboardPoll]);

  const teardownAll = useCallback(() => {
    teardownPeer();
    socketRef.current?.disconnect();
    socketRef.current = null;
  }, [teardownPeer]);

  // ── Data channel ──────────────────────────────────────────────────────────
  const openChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = 'arraybuffer';

      channel.addEventListener('open', () => {
        channelRef.current = channel;
        channel.send(
          JSON.stringify({
            type: 'device-hello',
            deviceId: deviceIdRef.current,
            publicKey: encodeBase64(keyPairRef.current.publicKey),
          }),
        );
      });

      channel.addEventListener('message', async (e: MessageEvent) => {
        const data = e.data;

        // Encrypted binary (file chunk)
        if (data instanceof ArrayBuffer) {
          const key = sharedKeyRef.current;
          if (!key) return;
          const plain = decryptBinary(data, key);
          if (!plain) return;
          const inbound = inboundFileRef.current;
          if (!inbound) return;
          inbound.chunks.push(plain);
          inbound.received += plain.byteLength;
          return;
        }

        if (typeof data !== 'string') return;

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { return; }

        // Unencrypted key exchange
        if (parsed.type === 'device-hello') {
          const peerPub = decodeBase64(parsed.publicKey as string);
          sharedKeyRef.current = nacl.box.before(peerPub, keyPairRef.current.secretKey);
          AsyncStorage.setItem(STORAGE_PEER_ID, parsed.deviceId as string).catch(() => {});
          setStatus('connected');
          startClipboardPoll();
          return;
        }

        // Encrypted text
        const key = sharedKeyRef.current;
        if (!key) return;
        const plaintext = decryptText(data, key);
        if (!plaintext) return;

        let control: {type?: string; name?: string; size?: number; mimeType?: string} | null = null;
        try { control = JSON.parse(plaintext); } catch { /* plain text */ }

        if (control?.type === 'file-start') {
          inboundFileRef.current = {
            name: control.name!, mimeType: control.mimeType!,
            chunks: [], received: 0, total: control.size!,
          };
          return;
        }

        if (control?.type === 'file-end') {
          const inbound = inboundFileRef.current;
          if (!inbound) return;
          try {
            await saveReceivedFile(inbound);
            setLastFile(inbound.name);
          } catch (err) {
            console.error('[Bifrost] file save:', err);
          }
          inboundFileRef.current = null;
          return;
        }

        // Plain clipboard text from desktop
        lastClipRef.current = plaintext;
        await Clipboard.setStringAsync(plaintext);
      });

      channel.addEventListener('close', () => {
        channelRef.current   = null;
        sharedKeyRef.current = null;
        stopClipboardPoll();
      });
    },
    [startClipboardPoll, stopClipboardPoll],
  );

  // ── Connect ───────────────────────────────────────────────────────────────
  const connect = useCallback(
    (peerId: string) => {
      teardownPeer();
      setStatus('connecting');
      setErrorMsg('');

      const socket = io(serverUrlRef.current, {transports: ['websocket']});
      socketRef.current = socket;

      socket.on('connect', () => socket.emit('join-room', peerId));

      socket.on('connect_error', () => {
        setStatus('error');
        setErrorMsg(`Cannot reach ${serverUrlRef.current}`);
      });

      socket.on('offer', async (offer: RTCSessionDescriptionInit) => {
        sharedKeyRef.current = null;
        keyPairRef.current   = nacl.box.keyPair();
        setStatus('securing');

        const pc = new RTCPeerConnection({iceServers: ICE_SERVERS});
        pcRef.current = pc;

        pc.addEventListener('datachannel', event => {
          const ch = (event as any).channel as RTCDataChannel;
          if (ch.label === 'bifrost-sync-channel') openChannel(ch);
        });

        pc.addEventListener('icecandidate', event => {
          const candidate = (event as any).candidate;
          if (candidate) socket.emit('ice-candidate', {candidate});
        });

        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setStatus('error');
            setErrorMsg('Connection lost. Reconnecting…');
          }
        });

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', {answer});
      });

      socket.on('ice-candidate', async (init: RTCIceCandidateInit) => {
        try { await pcRef.current?.addIceCandidate(new RTCIceCandidate(init)); }
        catch (e) { console.warn('[Bifrost] ICE:', e); }
      });

      socket.on('peer-disconnected', () => {
        teardownPeer();
        setStatus('connecting');
        socket.emit('join-room', peerId);
      });
    },
    [teardownPeer, openChannel],
  );

  // ── Startup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      const [myId, savedPeerId, savedServer] = await Promise.all([
        loadOrCreateDeviceId(),
        AsyncStorage.getItem(STORAGE_PEER_ID),
        AsyncStorage.getItem(STORAGE_SERVER),
      ]);
      if (!active) return;
      deviceIdRef.current  = myId;
      serverUrlRef.current = savedServer ?? DEFAULT_SERVER;
      setServerInput(serverUrlRef.current);

      if (savedPeerId) {
        peerIdRef.current = savedPeerId;
        setScreen('auto');
        connect(savedPeerId);
      } else {
        setScreen('pair');
      }
    })();
    return () => { active = false; teardownAll(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Deep link (QR scan) ───────────────────────────────────────────────────
  useEffect(() => {
    const handleUrl = (url: string) => {
      const parsed = Linking.parse(url);
      if (parsed.scheme !== 'bifrost' || parsed.hostname !== 'pair') return;
      const code = (parsed.path ?? '').replace(/^\//, '').toUpperCase();
      if (!/^[A-Z0-9]{8}$/.test(code)) return;
      AsyncStorage.setItem(STORAGE_PEER_ID, code).then(() => {
        peerIdRef.current = code;
        setScreen('auto');
        connect(code);
      });
    };

    Linking.getInitialURL().then(url => { if (url) handleUrl(url); });
    const sub = Linking.addEventListener('url', ({url}) => handleUrl(url));
    return () => sub.remove();
  }, [connect]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handlePair = useCallback(async () => {
    const code = pairInput.trim().toUpperCase();
    if (!code) return;
    await AsyncStorage.setItem(STORAGE_PEER_ID, code);
    peerIdRef.current = code;
    setScreen('auto');
    connect(code);
  }, [pairInput, connect]);

  const handleSend = useCallback(() => {
    const text = sendText.trim();
    const key  = sharedKeyRef.current;
    if (!text || channelRef.current?.readyState !== 'open' || !key) return;
    channelRef.current.send(encryptText(text, key));
    setSendText('');
  }, [sendText]);

  const handleForget = useCallback(async () => {
    teardownAll();
    await AsyncStorage.removeItem(STORAGE_PEER_ID);
    peerIdRef.current = '';
    setPairInput('');
    setScreen('pair');
  }, [teardownAll]);

  const handleSaveServer = useCallback(async () => {
    const url = serverInput.trim();
    if (!url) return;
    await AsyncStorage.setItem(STORAGE_SERVER, url);
    serverUrlRef.current = url;
    const next = peerIdRef.current ? 'auto' : 'pair';
    setScreen(next);
    if (peerIdRef.current) { teardownAll(); connect(peerIdRef.current); }
  }, [serverInput, teardownAll, connect]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (screen === 'loading') {
    return (
      <SafeAreaView style={styles.root}>
        <ActivityIndicator color="#818cf8" />
      </SafeAreaView>
    );
  }

  if (screen === 'settings') {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.title}>SETTINGS</Text>
        <Text style={styles.subtitle}>Signaling server URL</Text>
        <TextInput
          style={styles.serverInput}
          value={serverInput}
          onChangeText={setServerInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={handleSaveServer}
        />
        <TouchableOpacity style={styles.btn} onPress={handleSaveServer} activeOpacity={0.7}>
          <Text style={styles.btnText}>SAVE</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.forgetBtn}
          onPress={() => setScreen(peerIdRef.current ? 'auto' : 'pair')}
          activeOpacity={0.7}>
          <Text style={styles.forgetText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (screen === 'pair') {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.title}>BIFROST</Text>
        <Text style={styles.subtitle}>
          Scan the QR code on your desktop, or enter the 8-character pairing code.
        </Text>
        <TextInput
          style={styles.codeInput}
          placeholder="ABCD1234"
          placeholderTextColor="#444"
          value={pairInput}
          onChangeText={t =>
            setPairInput(t.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8))
          }
          autoCapitalize="characters"
          maxLength={8}
          returnKeyType="done"
          onSubmitEditing={handlePair}
        />
        <TouchableOpacity
          style={[styles.btn, !pairInput && styles.btnDisabled]}
          onPress={handlePair}
          disabled={!pairInput}
          activeOpacity={0.7}>
          <Text style={styles.btnText}>PAIR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.forgetBtn} onPress={() => setScreen('settings')} activeOpacity={0.7}>
          <Text style={styles.forgetText}>Server settings</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Auto (connected) screen ───────────────────────────────────────────────
  const isConnected = status === 'connected';
  const dotStyle =
    isConnected        ? styles.dotConnected  :
    status === 'error' ? styles.dotError      :
    status === 'securing' ? styles.dotSecuring :
    styles.dotConnecting;
  const textStyle =
    isConnected        ? styles.textConnected  :
    status === 'error' ? styles.textError      :
    status === 'securing' ? styles.textSecuring :
    styles.textConnecting;
  const label =
    isConnected           ? 'Encrypted and syncing'   :
    status === 'securing' ? 'Securing connection…'    :
    status === 'error'    ? errorMsg || 'Connection error' :
    'Connecting to desktop…';

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>BIFROST</Text>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, dotStyle]} />
        <Text style={[styles.statusText, textStyle]}>{label}</Text>
      </View>

      {lastFile ? <Text style={styles.fileLabel}>↓ {lastFile}</Text> : null}

      {isConnected && (
        <View style={styles.sendRow}>
          <TextInput
            style={styles.sendInput}
            placeholder="Type to send…"
            placeholderTextColor="#444"
            value={sendText}
            onChangeText={setSendText}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
          <TouchableOpacity style={styles.sendBtn} onPress={handleSend} activeOpacity={0.7}>
            <Text style={styles.btnText}>SEND</Text>
          </TouchableOpacity>
        </View>
      )}

      {isConnected ? <Text style={styles.clipLabel}>● clipboard watching</Text> : null}

      <View style={styles.footerRow}>
        <TouchableOpacity style={styles.forgetBtn} onPress={() => setScreen('settings')} activeOpacity={0.7}>
          <Text style={styles.forgetText}>Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.forgetBtn} onPress={handleForget} activeOpacity={0.7}>
          <Text style={styles.forgetText}>Forget Desktop</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1, backgroundColor: '#080808',
    alignItems: 'center', justifyContent: 'center',
    gap: 16, paddingHorizontal: 24,
  },
  title: {color: '#fff', fontSize: 22, fontWeight: '700', letterSpacing: 6, marginBottom: 4},
  subtitle: {color: '#555', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 8},
  codeInput: {
    borderWidth: 1, borderColor: '#2a2a2a', borderRadius: 8,
    color: '#fff', fontSize: 26, fontWeight: '700', letterSpacing: 6,
    textAlign: 'center', width: 220, paddingVertical: 12, backgroundColor: '#111',
  },
  serverInput: {
    borderWidth: 1, borderColor: '#2a2a2a', borderRadius: 8,
    color: '#fff', fontSize: 14, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#111', width: '100%',
  },
  btn: {backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 48, paddingVertical: 12},
  btnDisabled: {opacity: 0.25},
  btnText: {color: '#080808', fontSize: 14, fontWeight: '700', letterSpacing: 2},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  statusDot: {width: 8, height: 8, borderRadius: 4},
  dotConnected:  {backgroundColor: '#4caf50'},
  dotConnecting: {backgroundColor: '#a78bfa'},
  dotSecuring:   {backgroundColor: '#fbbf24'},
  dotError:      {backgroundColor: '#f44336'},
  statusText: {fontSize: 13},
  textConnected:  {color: '#4caf50'},
  textConnecting: {color: '#a78bfa'},
  textSecuring:   {color: '#fbbf24'},
  textError:      {color: '#f44336'},
  sendRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8},
  sendInput: {
    flex: 1, borderWidth: 1, borderColor: '#2a2a2a', borderRadius: 8,
    color: '#fff', fontSize: 14, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#111', minWidth: 180,
  },
  sendBtn: {backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12},
  clipLabel: {color: '#2e7d32', fontSize: 11, letterSpacing: 1},
  fileLabel: {color: '#4caf50', fontSize: 12},
  footerRow: {flexDirection: 'row', gap: 24, marginTop: 24},
  forgetBtn: {paddingVertical: 8, paddingHorizontal: 4},
  forgetText: {color: '#3f3f46', fontSize: 12, letterSpacing: 0.5},
});
