use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde_json::{Value, json};
use std::io::{self, Cursor, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak, mpsc};
use std::time::Duration;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, stream::MaybeTlsStream};

static DATA: OnceLock<PathBuf> = OnceLock::new();
static CORE: Mutex<Weak<crate::hc::Core>> = Mutex::new(Weak::new());
static HOME: Mutex<Option<PathBuf>> = Mutex::new(None);

pub struct AndroidLogWriter(Vec<u8>);

pub fn log_writer() -> AndroidLogWriter { AndroidLogWriter(Vec::new()) }

impl io::Write for AndroidLogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.0.extend_from_slice(bytes); Ok(bytes.len()) }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

impl Drop for AndroidLogWriter {
    fn drop(&mut self) { if !self.0.is_empty() { log::info!("{}", String::from_utf8_lossy(&self.0).trim_end()); } }
}

pub fn app_dir() -> PathBuf {
    DATA.get().expect("Android data folder is ready before Herdr starts").join("herdr-app")
}

pub fn home() -> PathBuf {
    HOME.lock().unwrap().clone().unwrap_or_else(|| PathBuf::from("/"))
}

/// The status and navigation bars take the theme's colors, so the app runs
/// edge to edge in one color instead of under a fixed dark strip. Android 15
/// draws apps under the bars and ignores bar colors, so the activity paints the
/// space under them itself (`herdrSystemBars`).
pub fn system_bars() {
    let argb = |name: &str| {
        let c = gpui::Rgba::from(crate::settings::color(name));
        let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
        (0xFF00_0000 | (byte(c.r) << 16) | (byte(c.g) << 8) | byte(c.b)) as i32
    };
    let light = |name: &str| crate::settings::color(name).l >= 0.5;
    let _ = gpui_mobile::android::jni::with_env(|env| {
        let activity = gpui_mobile::android::jni::activity(env)?;
        let args = [
            jni::objects::JValue::Int(argb("chrome")),
            jni::objects::JValue::Int(argb("background")),
            jni::objects::JValue::Bool(light("chrome")),
            jni::objects::JValue::Bool(light("background")),
        ];
        if env.call_method(&activity, jni::jni_str!("herdrSystemBars"), jni::jni_sig!("(IIZZ)V"), &args).is_err() {
            env.exception_clear();
        }
        Ok(())
    });
}

/// The system's own short tap feedback (honours the person's vibration setting).
pub fn haptic() {
    let _ = gpui_mobile::android::jni::with_env(|env| {
        let activity = gpui_mobile::android::jni::activity(env)?;
        if env.call_method(&activity, jni::jni_str!("herdrHaptic"), jni::jni_sig!("()V"), &[]).is_err() {
            env.exception_clear();
        }
        Ok(())
    });
}

/// Plays a sound file with Android's media player.
pub fn play_sound(path: &std::path::Path) -> Result<(), String> {
    gpui_mobile::android::jni::with_env(|env| {
        let activity = gpui_mobile::android::jni::activity(env)?;
        let path = env.new_string(path.to_string_lossy()).map_err(|e| e.to_string())?;
        let called = env.call_method(&activity, jni::jni_str!("herdrPlaySound"), jni::jni_sig!("(Ljava/lang/String;)V"), &[jni::objects::JValue::Object(&path)]);
        called.map(|_| ()).map_err(|e| { env.exception_clear(); e.to_string() })
    })
}

/// An agent needs the person or finished: a system notification, which shows
/// even while Herdr is in the background. Opening it brings Herdr back.
pub fn notify(title: &str, body: &str) {
    let sent = gpui_mobile::android::jni::with_env(|env| {
        let activity = gpui_mobile::android::jni::activity(env)?;
        let title = env.new_string(title).map_err(|e| e.to_string())?;
        let body = env.new_string(body).map_err(|e| e.to_string())?;
        let called = env.call_method(&activity, jni::jni_str!("herdrNotify"), jni::jni_sig!("(Ljava/lang/String;Ljava/lang/String;)V"),
            &[jni::objects::JValue::Object(&title), jni::objects::JValue::Object(&body)]);
        called.map(|_| ()).map_err(|e| { env.exception_clear(); e.to_string() })
    });
    if let Err(error) = sent {
        tracing::warn!("notification: {error}");
    }
}

/// Nothing is left to close: Android goes back to whatever was before Herdr.
pub fn leave() {
    let _ = gpui_mobile::android::jni::with_env(|env| {
        let activity = gpui_mobile::android::jni::activity(env)?;
        if env.call_method(&activity, jni::jni_str!("moveTaskToBack"), jni::jni_sig!("(Z)Z"), &[jni::objects::JValue::Bool(true)]).is_err() {
            env.exception_clear();
        }
        Ok(())
    });
}

pub fn start(data: PathBuf) {
    static BOOT: std::sync::Once = std::sync::Once::new();
    DATA.get_or_init(|| data);
    BOOT.call_once(|| {
        android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("herdr-android"));
        gpui_mobile::android::jni::install_panic_hook();
        std::thread::Builder::new().name("herdr-start".into()).spawn(crate::run).expect("Herdr startup thread");
    });
}

struct FrameReader {
    frames: mpsc::Receiver<Vec<u8>>,
    current: Cursor<Vec<u8>>,
}

impl Read for FrameReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() { return Ok(0); }
        while self.current.position() as usize == self.current.get_ref().len() {
            match self.frames.recv() {
                Ok(frame) => self.current = Cursor::new(frame),
                Err(_) => return Ok(0),
            }
        }
        self.current.read(out)
    }
}

pub fn transport() -> Result<(Value, mpsc::Sender<Vec<u8>>, impl Read + Send)> {
    let configured = crate::settings::load_person().ok().and_then(|person| person.core).filter(|core| !core.trim().is_empty());
    let configured = configured.context("Enter the address of the computer that runs Herdr.")?;
    let endpoint = configured.trim().trim_end_matches('/');
    let uri: tungstenite::http::Uri = endpoint.parse().context("Invalid Herdr server address")?;
    let secure = uri.scheme_str() == Some("https");
    let test_local = cfg!(debug_assertions) && uri.scheme_str() == Some("http") && uri.host() == Some("127.0.0.1");
    if !secure && !test_local { bail!("Use an HTTPS Herdr server address. Turn on Tailscale before connecting."); }
    if uri.path() != "/" || uri.query().is_some() || uri.authority().is_some_and(|a| a.as_str().contains('@')) {
        bail!("Enter the server address without a path or login.");
    }
    let host = uri.host().context("Herdr server address has no host")?;
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    let addresses = (host, port).to_socket_addrs().context("Cannot find Herdr. Check Tailscale.")?;
    let mut connected = None;
    for address in addresses {
        if let Ok(socket) = TcpStream::connect_timeout(&address, Duration::from_secs(6)) { connected = Some(socket); break; }
    }
    let tcp = connected.context("Cannot reach Herdr. Check Tailscale and try again.")?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(15)))?;
    tcp.set_nodelay(true)?;
    let websocket = format!("{}://{}/ws", if secure { "wss" } else { "ws" }, uri.authority().context("Herdr server address has no host")?);
    let mut request = websocket.into_client_request()?;
    request.headers_mut().insert("Origin", endpoint.parse()?);
    let mut config = tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(100 * 1024 * 1024);
    config.max_frame_size = config.max_message_size;
    let (mut socket, _) = tungstenite::client_tls_with_config(request, tcp, Some(config), None)
        .map_err(|error| anyhow!("Secure Herdr connection failed: {error}"))?;
    let hello = loop {
        match socket.read()? {
            Message::Text(text) => break serde_json::from_str::<Value>(&text)?,
            Message::Close(_) => bail!("Herdr closed the connection before it was ready."),
            _ => {}
        }
    };
    if hello.get("result").is_none() { bail!("Herdr refused the connection: {hello}"); }
    let tcp = match socket.get_ref() {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::Rustls(tls) => &tls.sock,
        _ => bail!("Unsupported secure connection"),
    };
    tcp.set_read_timeout(Some(Duration::from_millis(20)))?;
    let (writer, outgoing) = mpsc::channel::<Vec<u8>>();
    let (incoming, frames) = mpsc::channel();
    std::thread::Builder::new().name("herdr-android-transport".into()).spawn(move || {
        'connection: loop {
            for _ in 0..64 {
                match outgoing.try_recv() {
                    Ok(frame) => if socket.send(Message::Binary(frame.into())).is_err() { break 'connection; },
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break 'connection,
                }
            }
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if frame.len() < 9 { break; }
                    let size = u32::from_le_bytes(frame[5..9].try_into().unwrap()) as usize;
                    if size != frame.len() - 9 || incoming.send(frame.to_vec()).is_err() { break; }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {},
                Err(tungstenite::Error::Io(error)) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {},
                Err(_) => break,
            }
        }
        let _ = socket.close(None);
    })?;
    Ok((hello, writer, FrameReader { frames, current: Cursor::new(Vec::new()) }))
}

/// App files stay on Android; project files belong to the connected machine.
pub fn read_text_file(path: &str, on: Option<&str>) -> Result<Option<String>, String> {
    let local = DATA.get().and_then(|folder| folder.parent());
    let private = local.is_some_and(|folder| {
        let path = std::path::Path::new(path);
        path.starts_with(folder) || folder.canonicalize().is_ok_and(|real| path.starts_with(real))
    });
    if on.is_none() && private {
        return crate::mod_files::read(std::path::Path::new(path));
    }
    let core = CORE.lock().unwrap().upgrade().ok_or("Herdr is not connected")?;
    let reply = match core.call("file.read", json!({ "path": path, "on": on })) {
        Ok(reply) => reply,
        Err(error) if error.downcast_ref::<crate::hc::RpcError>().is_some_and(|error| error.kind() == Some("not_found")) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let text = reply["text"].as_str().ok_or("Herdr returned no file text")?;
    if text.len() as u64 > crate::mod_files::LIMIT || reply["last"].as_u64() < reply["lines"].as_u64() {
        return Err("Text file exceeds 1 MiB".into());
    }
    Ok(Some(text.into()))
}

pub fn connected(core: &Arc<crate::hc::Core>) {
    *CORE.lock().unwrap() = Arc::downgrade(core);
    if let Ok(reply) = core.call("machine.exec", json!({"argv": ["/bin/sh", "-c", "printf %s \"$HOME\""], "timeout": 5})) {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(reply["stdout"].as_str().unwrap_or_default()) {
            let path = String::from_utf8_lossy(&bytes).into_owned();
            if path.starts_with('/') { *HOME.lock().unwrap() = Some(path.into()); }
        }
    }
}

pub fn exec(command: &str, args: &[String], cwd: Option<String>, limit: Duration) -> Result<(i32, String, String), String> {
    let core = CORE.lock().unwrap().upgrade().ok_or("Herdr is not connected")?;
    let argv: Vec<&str> = std::iter::once(command).chain(args.iter().map(String::as_str)).collect();
    let reply = core.call_timeout("machine.exec", json!({"argv": argv, "cwd": cwd, "timeout": limit.as_secs_f64()}), limit + Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let decode = |key: &str| base64::engine::general_purpose::STANDARD.decode(reply[key].as_str().unwrap_or_default())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).map_err(|e| e.to_string());
    if reply["timed_out"] == true { return Err(format!("{command} took longer than {} seconds and was stopped", limit.as_secs())); }
    Ok((reply["code"].as_i64().unwrap_or(-1) as i32, decode("stdout")?, decode("stderr")?))
}
