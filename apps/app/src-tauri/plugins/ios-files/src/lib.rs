use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[derive(Deserialize)]
pub struct Selection {
    pub uri: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub uri: String,
    pub name: String,
    pub size: Option<i64>,
    pub lyrics_uri: Option<String>,
}
#[derive(Deserialize)]
pub struct Directory {
    pub name: String,
    pub files: Vec<Document>,
}
#[derive(Deserialize)]
pub struct Materialized {
    pub path: String,
}

pub struct IosFiles<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> IosFiles<R> {
    fn call<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        args: impl Serialize,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin(command, args)
            .map_err(|e| e.to_string())
    }
    pub fn pick_folder(&self) -> Result<Selection, String> {
        self.call("pickFolder", serde_json::json!({}))
    }
    pub fn storage_root(&self) -> Result<std::path::PathBuf, String> {
        let directory: Materialized = self.call("storageRoot", serde_json::json!({}))?;
        Ok(directory.path.into())
    }
    pub fn list(&self, uri: &str) -> Result<Directory, String> {
        self.call("list", serde_json::json!({ "uri": uri }))
    }
    pub fn materialize(&self, uri: &str) -> Result<Materialized, String> {
        self.call("materialize", serde_json::json!({ "uri": uri }))
    }
    pub fn release(&self, uri: &str) -> Result<(), String> {
        let _: serde_json::Value = self.call("release", serde_json::json!({ "uri": uri }))?;
        Ok(())
    }
}

pub trait IosFilesExt<R: Runtime> {
    fn ios_files(&self) -> &IosFiles<R>;
}
impl<R: Runtime, T: Manager<R>> IosFilesExt<R> for T {
    fn ios_files(&self) -> &IosFiles<R> {
        self.state::<IosFiles<R>>().inner()
    }
}

tauri::ios_plugin_binding!(init_plugin_ios_files);
tauri::ios_plugin_binding!(init_plugin_mobile_playback);

pub fn register_playback<R: Runtime>(
    api: &tauri::plugin::PluginApi<R, ()>,
) -> Result<PluginHandle<R>, tauri::plugin::mobile::PluginInvokeError> {
    api.register_ios_plugin(init_plugin_mobile_playback)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ios-files")
        .setup(|app, api| {
            let handle = api.register_ios_plugin(init_plugin_ios_files)?;
            app.manage(IosFiles(handle));
            Ok(())
        })
        .build()
}
