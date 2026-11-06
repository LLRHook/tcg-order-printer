"""Independent ZIP interoperability/parity checks, with synthetic temporary roots."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

SOURCE = Path(__file__).resolve().parents[3]
BINARY = os.environ['TCG_PACKAGER_BIN']
FILES = [
    'background.js', 'core.js', 'content.js', 'content.css', 'pdf-bridge.js',
    'popup.html', 'popup.css', 'popup.js', 'setup.html', 'setup.css', 'setup.js',
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
]


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tcg-packager-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'extension with spaces'
        self.root.mkdir()
        for name in FILES + ['manifest.json']:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / name, destination)
        self.manifest = json.loads((self.root / 'manifest.json').read_text())
        self.archive = self.root / 'dist' / f'tcg-order-printer-{self.manifest["version"]}.zip'

    def run_packager(self, success=True):
        result = subprocess.run([BINARY, str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def change_manifest(self, value):
        (self.root / 'manifest.json').write_text(json.dumps(value))

    def assert_preserved(self, mutation):
        self.run_packager()
        original = self.archive.read_bytes()
        mutation()
        self.run_packager(False)
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertFalse(list(self.archive.parent.glob('*.tmp')))

    def test_archive_matches_the_previous_runtime_allowlist_and_bytes(self):
        (self.root / 'private-note.txt').write_text('Synthetic file that must stay out')
        self.run_packager()
        with zipfile.ZipFile(self.archive) as archive:
            self.assertIsNone(archive.testzip())  # independent CRC + header reader
            self.assertEqual(set(archive.namelist()), set(FILES + ['manifest.json', 'icons/']))
            for name in FILES:
                self.assertEqual(archive.read(name), (self.root / name).read_bytes(), name)
            expected = dict(self.manifest)
            expected.pop('key', None)
            self.assertEqual(json.loads(archive.read('manifest.json')), expected)
            for info in archive.infolist():
                self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.flag_bits & 0x800, 0x800)
                self.assertEqual(info.create_system, 3)
        self.assertIn('key', json.loads((self.root / 'manifest.json').read_text()))

    def test_repeated_packages_are_identical_despite_source_metadata(self):
        self.run_packager()
        first = self.archive.read_bytes()
        for name in FILES:
            os.utime(self.root / name, (1700000000, 1700000000))
        self.run_packager()
        self.assertEqual(first, self.archive.read_bytes())

    def test_default_root_preserves_the_normal_package_path_output(self):
        result = subprocess.run([BINARY], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f'dist/{self.archive.name}\n')
        self.assertTrue(self.archive.is_file())

    def test_missing_asset_keeps_the_previous_archive(self):
        self.assert_preserved(lambda: (self.root / 'content.js').unlink())

    def test_malformed_json_keeps_the_previous_archive(self):
        self.assert_preserved(lambda: (self.root / 'manifest.json').write_text('{invalid'))

    def test_unsafe_version_cannot_choose_an_output_path(self):
        invalid = dict(self.manifest, version='../unsafe')
        self.assert_preserved(lambda: self.change_manifest(invalid))
        self.assertFalse((self.root / 'unsafe.zip').exists())

    def test_nested_keys_and_unicode_survive_manifest_serialization(self):
        changed = dict(self.manifest, name='Synthetic \u2603', nested={'key': 'keep'})
        self.change_manifest(changed)
        self.run_packager()
        with zipfile.ZipFile(self.archive) as archive:
            packed = json.loads(archive.read('manifest.json'))
            self.assertEqual(packed['name'], changed['name'])
            self.assertEqual(packed['nested']['key'], 'keep')
            self.assertNotIn('key', packed)

    @unittest.skipUnless(hasattr(os, 'symlink'), 'symlinks unavailable')
    def test_linked_source_is_refused_without_reading_its_target(self):
        target = self.root / 'synthetic-outside.txt'
        target.write_text('Do not include this synthetic target')
        def mutation():
            (self.root / 'content.js').unlink()
            (self.root / 'content.js').symlink_to(target)
        self.assert_preserved(mutation)

    @unittest.skipUnless(hasattr(os, 'symlink'), 'symlinks unavailable')
    def test_linked_icons_directory_is_refused(self):
        def mutation():
            (self.root / 'icons').rename(self.root / 'icons-original')
            (self.root / 'icons').symlink_to(self.root / 'icons-original', target_is_directory=True)
        self.assert_preserved(mutation)

    @unittest.skipUnless(hasattr(os, 'symlink'), 'symlinks unavailable')
    def test_linked_output_directory_is_not_written(self):
        elsewhere = self.root / 'synthetic-elsewhere'
        elsewhere.mkdir()
        (self.root / 'dist').symlink_to(elsewhere, target_is_directory=True)
        result = self.run_packager(False)
        self.assertIn('dist must be a directory', result.stderr)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_failed_output_replace_removes_only_its_temporary_file(self):
        self.archive.mkdir(parents=True)
        self.run_packager(False)
        self.assertTrue(self.archive.is_dir())
        self.assertFalse(list(self.archive.parent.glob('*.tmp')))

    def test_oversized_source_is_refused_before_reading_or_output(self):
        with (self.root / 'content.js').open('wb') as source:
            source.truncate(64 * 1024 * 1024 + 1)  # sparse, synthetic fixture
        result = self.run_packager(False)
        self.assertIn('64 MiB', result.stderr)
        self.assertFalse(self.archive.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
