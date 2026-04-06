import serial
import time
import random
import argparse
import sys

# 一些用于随机发送的英文单词和中文词汇
ENGLISH_WORDS = [
    "hello", "world", "test", "serial", "terminal", "communication",
    "data", "packet", "error", "warning", "success", "info", "debug",
    "connection", "timeout", "reconnect", "byte", "stream", "buffer",
    "python", "script", "random", "generator", "port", "baudrate"
]

CHINESE_WORDS = [
    "你好", "世界", "测试", "串口", "终端", "通信",
    "数据", "数据包", "错误", "警告", "成功", "信息", "调试",
    "连接", "超时", "重连", "字节", "流", "缓冲区",
    "脚本", "随机", "生成器", "端口", "波特率"
]

LOG_LEVELS = ["[INFO]", "[DEBUG]", "[WARN]", "[ERROR]"]

def generate_random_message():
    """生成一条随机包含中英文的消息"""
    num_words = random.randint(3, 8)
    message_parts = []
    
    # 随机选择日志级别
    message_parts.append(random.choice(LOG_LEVELS))
    
    for _ in range(num_words):
        # 随机选择英文或中文单词
        if random.random() > 0.4:  # 60% 概率英文
            message_parts.append(random.choice(ENGLISH_WORDS))
        else:                      # 40% 概率中文
            message_parts.append(random.choice(CHINESE_WORDS))
            
    # 用空格连接单词，并加上换行符
    return " ".join(message_parts) + "\r\n"

def main():
    parser = argparse.ArgumentParser(description="串口随机数据发送测试工具")
    parser.add_argument("-p", "--port", type=str, required=True, help="串口名称，例如 COM1 或 /dev/ttyUSB0")
    parser.add_argument("-b", "--baudrate", type=int, default=115200, help="波特率，默认 115200")
    parser.add_argument("-i", "--interval", type=float, default=1.0, help="发送间隔（秒），默认 1.0")
    parser.add_argument("-e", "--encoding", type=str, default="utf-8", help="编码格式，默认 utf-8")
    
    args = parser.parse_args()
    
    print(f"尝试连接串口: {args.port}, 波特率: {args.baudrate}, 编码: {args.encoding}")
    
    try:
        # 打开串口
        ser = serial.Serial(
            port=args.port,
            baudrate=args.baudrate,
            timeout=1
        )
        
        if ser.is_open:
            print(f"串口 {ser.name} 已打开。按 Ctrl+C 停止发送。")
            print(f"发送间隔: {args.interval} 秒\n")
            
            count = 1
            while True:
                # 生成随机消息
                msg = generate_random_message()
                
                # 编码并发送
                try:
                    data_to_send = msg.encode(args.encoding)
                    ser.write(data_to_send)
                    print(f"[{count}] 已发送: {msg.strip()}")
                    count += 1
                except UnicodeEncodeError as e:
                    print(f"编码错误: {e}")
                
                # 等待指定间隔
                time.sleep(args.interval)
                
    except serial.SerialException as e:
        print(f"串口错误: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n测试已停止。")
    finally:
        if 'ser' in locals() and ser.is_open:
            ser.close()
            print("串口已关闭。")

if __name__ == "__main__":
    main()
