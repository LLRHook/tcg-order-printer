use std::path::Path;
use std::process::Command;

#[test]
fn independent_zip_reader_checks_packaging_parity_and_failure_safety() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/package.py");
    let output = Command::new("python3")
        .arg(script)
        .env(
            "TCG_PACKAGER_BIN",
            env!("CARGO_BIN_EXE_tcg-order-printer-packager"),
        )
        .output()
        .expect("Python 3 is required for independent ZIP verification");
    print!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "package parity/error checks failed"
    );
}
