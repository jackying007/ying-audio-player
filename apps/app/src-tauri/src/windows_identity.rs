use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
use windows::{
    core::{Interface, HSTRING, PCWSTR},
    Win32::{
        Globalization::{CompareStringOrdinal, CSTR_EQUAL},
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                StructuredStorage::{PropVariantClear, PropVariantToString, PROPVARIANT},
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            Variant::VT_LPWSTR,
        },
        UI::Shell::{
            FOLDERID_Programs, GetCurrentProcessExplicitAppUserModelID, IShellLinkW,
            PropertiesSystem::IPropertyStore, SHGetKnownFolderPath, SHStrDupW,
            SetCurrentProcessExplicitAppUserModelID, ShellLink, KF_FLAG_CREATE, SLGP_RAWPATH,
        },
    },
};

struct Apartment;

impl Apartment {
    fn initialize() -> windows::core::Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) fn register(config: &tauri::Config) -> Result<(), Box<dyn std::error::Error>> {
    let _apartment = Apartment::initialize()?;
    let mut id = config.identifier.clone();
    let mut name = config.product_name.clone().unwrap_or_else(|| id.clone());
    if cfg!(debug_assertions) {
        id.push_str(".dev");
        name.push_str(" (Dev)");
    }

    let executable = std::env::current_exe()?;
    let programs = unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_CREATE, None)?;
        let programs = PathBuf::from(OsString::from_wide(path.as_wide()));
        CoTaskMemFree(Some(path.as_ptr().cast()));
        programs
    };
    let shortcut = programs.join(format!("{name}.lnk"));
    let id = HSTRING::from(id);
    // The Shell resolves the media session's process ID through the Start menu link.
    save_shortcut(
        &HSTRING::from(shortcut.as_os_str()),
        &HSTRING::from(executable.as_os_str()),
        &id,
    )?;
    unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr()))? };
    Ok(())
}

pub(super) fn process_app_id() -> windows::core::Result<HSTRING> {
    unsafe {
        let id = GetCurrentProcessExplicitAppUserModelID()?;
        let value = HSTRING::from_wide(id.as_wide());
        CoTaskMemFree(Some(id.as_ptr().cast()));
        Ok(value)
    }
}

fn save_shortcut(
    shortcut: &HSTRING,
    executable: &HSTRING,
    id: &HSTRING,
) -> windows::core::Result<()> {
    if shortcut_matches(shortcut, executable, id).unwrap_or(false) {
        return Ok(());
    }
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        let properties: IPropertyStore = link.cast()?;
        link.SetPath(PCWSTR(executable.as_ptr()))?;

        let mut value = PROPVARIANT::default();
        let fields = &mut *value.Anonymous.Anonymous;
        fields.vt = VT_LPWSTR;
        fields.Anonymous.pwszVal = SHStrDupW(PCWSTR(id.as_ptr()))?;
        let result = properties.SetValue(&PKEY_AppUserModel_ID, &value);
        PropVariantClear(&mut value)?;
        result?;
        properties.Commit()?;
        file.Save(PCWSTR(shortcut.as_ptr()), false)
    }
}

fn shortcut_matches(
    shortcut: &HSTRING,
    executable: &HSTRING,
    id: &HSTRING,
) -> windows::core::Result<bool> {
    let mut target = vec![0; executable.len() + 2];
    let mut stored_id = [0; 129];
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.cast::<IPersistFile>()?
            .Load(PCWSTR(shortcut.as_ptr()), STGM_READ)?;
        link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)?;
        let target = target.split(|&unit| unit == 0).next().unwrap_or_default();
        if CompareStringOrdinal(target, executable, true) != CSTR_EQUAL {
            return Ok(false);
        }
        let mut value = link
            .cast::<IPropertyStore>()?
            .GetValue(&PKEY_AppUserModel_ID)?;
        let result = PropVariantToString(&value, &mut stored_id);
        PropVariantClear(&mut value)?;
        result?;
        Ok(stored_id.split(|&unit| unit == 0).next() == Some(&**id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_keeps_its_app_id_when_the_portable_exe_moves() {
        let _apartment = Apartment::initialize().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let shortcut_path = dir.path().join("嘤嘤播放器.lnk");
        let shortcut = HSTRING::from(shortcut_path.as_os_str());
        let id = HSTRING::from("ying.audio.player");

        for filename in ["YingAudioPlayer.exe", "Moved Player.exe"] {
            let target = dir.path().join(filename);
            std::fs::File::create(&target).unwrap();
            let target = HSTRING::from(target.as_os_str());
            save_shortcut(&shortcut, &target, &id).unwrap();
            assert!(shortcut_matches(&shortcut, &target, &id).unwrap());
        }
    }
}
