pub enum LoadError { PermissionDenied, Disconnected }

pub fn classify_error(_error: std::io::Error) -> LoadError {
    LoadError::Disconnected
}

// Callers pick a recovery from the classified error, so the two kinds must stay distinct.
pub fn recovery(error: LoadError) -> &'static str {
    match error {
        LoadError::PermissionDenied => "Ask the user to fix file access; do not retry",
        LoadError::Disconnected => "Retry the operation after reconnecting",
    }
}
