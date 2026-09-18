// Invalid input from the settings form must be returned as a validation error.
pub fn parse_port(input: &str) -> Result<u16, String> {
    input.parse::<u16>().map_err(|_| "Enter a port from 0 to 65535".to_owned())
}

pub fn settings_response(input: &str) -> String {
    match parse_port(input) {
        Ok(port) => format!("Port set to {port}"),
        Err(message) => format!("Invalid settings: {message}"),
    }
}
