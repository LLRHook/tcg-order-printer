use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const FILES: &[&str] = &[
    "background.js",
    "core.js",
    "content.js",
    "content.css",
    "pdf-bridge.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "setup.html",
    "setup.css",
    "setup.js",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
];
const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

fn main() {
    let mut args = env::args_os().skip(1);
    let root = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if args.next().is_some() {
        eprintln!("Usage: tcg-order-printer-packager [extension-root]");
        std::process::exit(2);
    }
    match package(&root) {
        Ok(path) => println!("{}", path.strip_prefix(".").unwrap_or(&path).display()),
        Err(error) => {
            eprintln!("Packaging failed: {error}");
            std::process::exit(1);
        }
    }
}

fn read_source(root: &Path, name: &str) -> Result<Vec<u8>> {
    let path = root.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("cannot read {name}: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{name} must be a regular file, not a symlink"));
    }
    if metadata.len() > MAX_PACKAGE_BYTES {
        return Err(format!("{name} exceeds the 64 MiB package limit"));
    }
    fs::read(path).map_err(|e| format!("cannot read {name}: {e}"))
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    (1..=4).contains(&parts.len())
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
                && p.parse::<u16>().is_ok()
        })
        && parts.iter().any(|p| *p != "0")
}

fn store_manifest(source: &[u8]) -> Result<(String, Vec<u8>)> {
    // Keep Node's JSON parser and serialization, matching the previous package
    // script byte for byte. Rust owns file selection, ZIP encoding and output.
    let node = env::var_os("npm_node_execpath").unwrap_or_else(|| "node".into());
    let mut child = Command::new(node)
        .args(["-e", r#"
try {
  const manifest = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || typeof manifest.version !== 'string') throw new Error();
  const version = manifest.version;
  if (/[^0-9.]/.test(version)) throw new Error();
  delete manifest.key;
  process.stdout.write(version + '\n' + JSON.stringify(manifest, null, 2) + '\n');
} catch {
  process.stderr.write('manifest.json must be valid JSON with a string version.\n');
  process.exitCode = 1;
}
"#])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("cannot start Node for manifest.json; install Node 22: {e}"))?;
    let written = child.stdin.take().expect("piped stdin").write_all(source);
    let output = child
        .wait_with_output()
        .map_err(|e| format!("cannot check manifest.json: {e}"))?;
    if !output.status.success() {
        return Err("manifest.json must be valid JSON with a string version".into());
    }
    written.map_err(|e| format!("cannot send manifest.json to Node: {e}"))?;
    let split = output
        .stdout
        .iter()
        .position(|b| *b == b'\n')
        .ok_or("invalid manifest response from Node")?;
    let version =
        std::str::from_utf8(&output.stdout[..split]).map_err(|_| "invalid manifest version")?;
    if !valid_version(version) {
        return Err("manifest version must contain 1 to 4 integers from 0 to 65535, without leading zeroes, and cannot be all zero".into());
    }
    Ok((version.into(), output.stdout[split + 1..].to_vec()))
}

fn package(root: &Path) -> Result<PathBuf> {
    // Validate every input before opening an output, preserving the previous
    // ZIP on malformed manifests, missing assets or unsafe source links.
    let (version, manifest) = store_manifest(&read_source(root, "manifest.json")?)?;
    let icons =
        fs::symlink_metadata(root.join("icons")).map_err(|e| format!("cannot read icons: {e}"))?;
    if !icons.is_dir() || icons.file_type().is_symlink() {
        return Err("icons must be a directory, not a symlink".into());
    }
    let mut entries = vec![("manifest.json", manifest), ("icons/", Vec::new())];
    let mut total = entries[0].1.len() as u64;
    for name in FILES {
        let bytes = read_source(root, name)?;
        total += bytes.len() as u64;
        if total > MAX_PACKAGE_BYTES {
            return Err("extension assets exceed the 64 MiB package limit".into());
        }
        entries.push((name, bytes));
    }
    entries.sort_by_key(|(name, _)| *name);
    let archive = zip(&entries);
    let dist = root.join("dist");
    match fs::symlink_metadata(&dist) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => (),
        Ok(_) => return Err("dist must be a directory, not a symlink".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&dist).map_err(|e| format!("cannot create dist: {e}"))?;
        }
        Err(e) => return Err(format!("cannot inspect dist: {e}")),
    }
    let output = dist.join(format!("tcg-order-printer-{version}.zip"));
    atomic_write(&output, &archive)?;
    Ok(output)
}

fn atomic_write(output: &Path, bytes: &[u8]) -> Result<()> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = output.with_extension(format!("zip.{}.{nonce}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| format!("cannot create temporary package in dist: {e}"))?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, output)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("cannot replace package in dist: {error}"));
    }
    Ok(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
fn u16_le(out: &mut Vec<u8>, value: u16) {
    out.extend(value.to_le_bytes());
}
fn u32_le(out: &mut Vec<u8>, value: u32) {
    out.extend(value.to_le_bytes());
}

// PKWARE APPNOTE 6.3.10, sections 4.3.7, 4.3.12 and 4.3.16. Only STORE is
// needed for this small fixed allowlist; no ZIP64, compression or extra fields.
// Fixed timestamps, permissions and ordering make repeated builds identical.
fn zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for (name, bytes) in entries {
        // package() bounds this fixed entry list and its total to 64 MiB.
        let offset = out.len() as u32;
        let size = bytes.len() as u32;
        let crc = crc32(bytes);
        u32_le(&mut out, 0x04034b50);
        for value in [20, 0x0800, 0, 0, 0x0021] {
            u16_le(&mut out, value);
        }
        for value in [crc, size, size] {
            u32_le(&mut out, value);
        }
        u16_le(&mut out, name.len() as u16);
        u16_le(&mut out, 0);
        out.extend(name.as_bytes());
        out.extend(bytes);

        u32_le(&mut directory, 0x02014b50);
        for value in [0x0314, 20, 0x0800, 0, 0, 0x0021] {
            u16_le(&mut directory, value);
        }
        for value in [crc, size, size] {
            u32_le(&mut directory, value);
        }
        u16_le(&mut directory, name.len() as u16);
        for _ in 0..4 {
            u16_le(&mut directory, 0);
        }
        u32_le(
            &mut directory,
            if name.ends_with('/') {
                (0o040755 << 16) | 0x10
            } else {
                0o100644 << 16
            },
        );
        u32_le(&mut directory, offset);
        directory.extend(name.as_bytes());
    }
    let directory_offset = out.len() as u32;
    let directory_size = directory.len() as u32;
    out.extend(directory);
    u32_le(&mut out, 0x06054b50);
    u16_le(&mut out, 0);
    u16_le(&mut out, 0);
    u16_le(&mut out, entries.len() as u16);
    u16_le(&mut out, entries.len() as u16);
    u32_le(&mut out, directory_size);
    u32_le(&mut out, directory_offset);
    u16_le(&mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_standard_check_vector_and_empty_input() {
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"\0\xff\x80"), 0x81dda740);
    }
    #[test]
    fn chrome_versions_cannot_escape_the_output_directory() {
        for valid in ["1", "1.0", "0.1.0.0", "65535.2.3.4"] {
            assert!(valid_version(valid), "{valid}");
        }
        for invalid in [
            "",
            "0",
            "0.0.0.0",
            "01.0",
            "1..0",
            "1.2.3.4.5",
            "65536",
            "../1",
            "1/2",
            "1\\2",
            "1\n2",
            "+1",
            "1. 2",
        ] {
            assert!(!valid_version(invalid), "{invalid}");
        }
    }
    #[test]
    fn manifest_transformation_preserves_nested_keys_and_unicode() {
        let (version, bytes) = store_manifest(br#"{"version":"1.2.3","key":"development","nested":{"key":"keep"},"name":"Synthetic \u2603"}"#).unwrap();
        assert_eq!(version, "1.2.3");
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("development"));
        assert!(text.contains("\"key\": \"keep\""));
        assert!(text.contains('☃'));
        assert!(text.ends_with('\n'));
    }
    #[test]
    fn malformed_or_unsafe_manifests_are_refused() {
        for input in [
            r#"{"version":"../bad"}"#,
            r#"{"version":1}"#,
            r#"{"version":"1\nunsafe"}"#,
            r#"{"version":"1\n"}"#,
            r#"null"#,
            r#"[]"#,
            r#"{broken"#,
        ] {
            assert!(store_manifest(input.as_bytes()).is_err(), "{input}");
        }
    }
    #[test]
    fn zip_has_stored_utf8_entries_and_deterministic_headers() {
        let entries = vec![("empty/", vec![]), ("file.txt", b"test".to_vec())];
        let bytes = zip(&entries);
        assert_eq!(bytes, zip(&entries));
        assert_eq!(&bytes[..4], &0x04034b50_u32.to_le_bytes());
        assert_eq!(&bytes[6..8], &0x0800_u16.to_le_bytes());
        assert_eq!(&bytes[8..10], &[0, 0]);
        let end = &bytes[bytes.len() - 22..];
        assert_eq!(&end[..4], &0x06054b50_u32.to_le_bytes());
        assert_eq!(u16::from_le_bytes(end[10..12].try_into().unwrap()), 2);
        let offset = u32::from_le_bytes(end[16..20].try_into().unwrap()) as usize;
        assert_eq!(&bytes[offset..offset + 4], &0x02014b50_u32.to_le_bytes());
    }
}
