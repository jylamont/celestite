require "spec"
require "../src/celestite"

ENV["CELESTITE"] = "test"

def get_logger
  Logger.new(STDOUT)
end

def run_spec_server(renderer, timeout = 10.seconds)
  channel = Channel(Process).new

  IO.pipe do |reader, writer|
    # multi = IO::MultiWriter.new(STDOUT, writer) # # uncomment for debugging
    now = Time.monotonic
    # renderer.logger = Logger.new(multi) # uncomment for debugging
    renderer.logger = Logger.new(writer)
    spawn do
      proc = renderer.start_server
      channel.send(proc)
    end

    begin
      proc = channel.receive
      loop do
        # break if reader.gets =~ /SSR renderer listening/
        break if reader.gets =~ /Webpack compilation complete/
        raise "Node server failed to start within timeout" if ((Time.monotonic - now) > timeout)
        raise "Node server terminated due to fault" if proc.terminated?
        sleep 0.1
      end
      yield
    ensure
      renderer.kill_server
    end
  end
end
