use crate::ipc::protocol::{IpcEnvelope, MAX_MESSAGE_SIZE_BYTES};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    envelope: &IpcEnvelope,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let json_bytes = serde_json::to_vec(envelope)?;
    let len = json_bytes.len();

    if len > MAX_MESSAGE_SIZE_BYTES {
        return Err(format!("Payload size {} exceeds maximum limit of {} bytes", len, MAX_MESSAGE_SIZE_BYTES).into());
    }

    let len_prefix = (len as u32).to_le_bytes();
    writer.write_all(&len_prefix).await?;
    writer.write_all(&json_bytes).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<IpcEnvelope>, Box<dyn std::error::Error + Send + Sync>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }

    let len = u32::from_le_bytes(header) as usize;
    if len > MAX_MESSAGE_SIZE_BYTES {
        return Err(format!("Incoming frame size {} exceeds limit of {} bytes", len, MAX_MESSAGE_SIZE_BYTES).into());
    }

    let mut buffer = vec![0u8; len];
    reader.read_exact(&mut buffer).await?;

    let envelope: IpcEnvelope = serde_json::from_slice(&buffer)?;
    Ok(Some(envelope))
}

