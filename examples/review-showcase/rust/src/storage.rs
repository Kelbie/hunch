use std::io::ErrorKind;

pub enum LoadError { PermissionDenied, Disconnected }

pub fn classify_error(error: std::io::Error) -> LoadError {
    match error.kind() {
        ErrorKind::PermissionDenied => LoadError::PermissionDenied,
        _ => LoadError::Disconnected,
    }
}

pub fn recovery(error: LoadError) -> &'static str {
    match error {
        LoadError::PermissionDenied => "Ask the user to fix file access; do not retry",
        LoadError::Disconnected => "Retry the operation after reconnecting",
    }
}
