#![cfg(target_os = "android")]

use gpui_mobile::android::{host, jni as bridge};
use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JObject, JString};

#[derive(Debug)]
struct BridgeError(String);
impl std::fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { self.0.fmt(formatter) }
}
impl std::error::Error for BridgeError {}
impl From<jni::errors::Error> for BridgeError {
    fn from(error: jni::errors::Error) -> Self { Self(error.to_string()) }
}

// The platform library links this symbol even with an Activity-owned view.
#[unsafe(no_mangle)]
fn android_main(_: android_activity::AndroidApp) {}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeStart<'local>(
    mut env: EnvUnowned<'local>, this: JObject<'local>, folder: JString<'local>,
) {
    env.with_env(|env| -> Result<(), BridgeError> {
        bridge::set_host_activity(env, &this).map_err(BridgeError)?;
        let folder = bridge::get_string(env, folder.as_ref());
        if folder.is_empty() { return Err(BridgeError("Android private folder is missing".into())); }
        herdr_app::run_android(folder.into());
        Ok(())
    }).resolve::<ThrowRuntimeExAndDefault>();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeSurface<'local>(
    mut env: EnvUnowned<'local>, _this: JObject<'local>, surface: JObject<'local>, density: f32,
) {
    env.with_env(|env| -> Result<(), BridgeError> {
        let window = unsafe { ndk::native_window::NativeWindow::from_surface(env.get_raw().cast(), surface.as_raw().cast()) };
        host::surface_created(window.ok_or_else(|| BridgeError("Android surface is missing".into()))?, density);
        Ok(())
    }).resolve::<ThrowRuntimeExAndDefault>();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeSurfaceDestroyed(_env: EnvUnowned<'_>, _this: JObject<'_>) {
    host::surface_destroyed();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeTouch(_env: EnvUnowned<'_>, _this: JObject<'_>, action: i32, id: i32, x: f32, y: f32) {
    host::motion_event(action as u32, 0, &[host::Pointer { id, x, y }]);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeKey(_env: EnvUnowned<'_>, _this: JObject<'_>, code: i32, action: i32, modifiers: i32) {
    host::key(code, action, modifiers);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeResume(_env: EnvUnowned<'_>, _this: JObject<'_>) {
    host::resumed();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativePause(_env: EnvUnowned<'_>, _this: JObject<'_>) {
    host::paused();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herdr_android_HerdrActivity_nativeRun<'local>(
    mut env: EnvUnowned<'local>, _this: JObject<'local>, command: JString<'local>,
) {
    env.with_env(|env| -> Result<(), BridgeError> {
        herdr_app::android_run(bridge::get_string(env, command.as_ref()));
        Ok(())
    }).resolve::<ThrowRuntimeExAndDefault>();
}
