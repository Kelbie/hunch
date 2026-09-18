// Invalid input from the settings form must be returned as a validation error.
pub fn parse_port(input: &str) -> Result<u16, String> {
    Ok(input.parse::<u16>().unwrap())
}

pub fn settings_response(input: &str) -> String {
    match parse_port(input) {
        Ok(port) => format!("Port set to {port}"),
        Err(message) => format!("Invalid settings: {message}"),
    }
}
