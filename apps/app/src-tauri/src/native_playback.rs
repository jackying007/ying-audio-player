#[cfg(any(mobile, target_os = "windows", target_os = "macos", test))]
mod cover;
#[cfg(any(mobile, target_os = "windows", target_os = "macos", test))]
mod http;
#[cfg(any(mobile, target_os = "windows", target_os = "macos", test))]
mod model;
mod queue;

#[cfg(any(mobile, target_os = "windows", target_os = "macos"))]
mod media;
#[cfg(any(mobile, target_os = "windows", target_os = "macos"))]
mod session;
#[cfg(any(mobile, target_os = "windows", target_os = "macos"))]
pub(crate) use session::init;

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod desktop;
