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

pub struct AndroidFiles<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> AndroidFiles<R> {
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

pub trait AndroidFilesExt<R: Runtime> {
    fn android_files(&self) -> &AndroidFiles<R>;
}
impl<R: Runtime, T: Manager<R>> AndroidFilesExt<R> for T {
    fn android_files(&self) -> &AndroidFiles<R> {
        self.state::<AndroidFiles<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-files")
        .setup(|app, api| {
            let handle = api
                .register_android_plugin("ying.audio.player.androidfiles", "AndroidFilesPlugin")?;
            app.manage(AndroidFiles(handle));
            Ok(())
        })
        .build()
}
